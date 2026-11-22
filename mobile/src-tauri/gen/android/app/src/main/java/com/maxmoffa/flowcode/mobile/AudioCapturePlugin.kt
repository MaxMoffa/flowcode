package com.maxmoffa.flowcode.mobile

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "AudioCapturePlugin"
private const val PERMISSION_ALIAS = "microphone"
private const val SAMPLE_RATE = 16000
// 100 ms of 16-bit mono.
private const val CHUNK_BYTES = 3200

/**
 * Raw microphone capture for remote dictation: 16 kHz mono PCM16, handed to
 * Rust as base64 `chunk` events (about 100 ms each) that it streams to the
 * desktop. `error` carries a short code if the recorder dies. One capture at a
 * time.
 */
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = PERMISSION_ALIAS)])
class AudioCapturePlugin(private val activity: Activity) : Plugin(activity) {
    private val lock = Any()
    private var thread: Thread? = null

    /** The live capture's own stop flag: a pump that outlives a timed-out join still sees only its own. */
    @Volatile
    private var stopFlag: AtomicBoolean? = null

    /** Permission requests whose dialog is still up; see `onDestroy`. */
    private val pendingPermission = mutableListOf<Invoke>()

    /** Bumped by every stop/cancel; a permission request that started under an older value is dropped. Guarded by `pendingPermission` for the map. */
    private val permissionEpoch = AtomicInteger()
    private val permissionEpochs = HashMap<Invoke, Int>()

    private fun granted(): Boolean =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun fail(code: String) {
        trigger("error", JSObject().apply { put("message", code) })
    }

    private fun emitChunk(buf: ByteArray, len: Int) {
        // NO_WRAP: one JSON string, no line breaks.
        trigger("chunk", JSObject().apply { put("data", Base64.encodeToString(buf, 0, len, Base64.NO_WRAP)) })
    }

    /** Starts recording; false if the recorder cannot be had. */
    private fun begin(): Boolean {
        synchronized(lock) {
            endLocked()
            val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (min <= 0) return false
            val rec = try {
                AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    maxOf(min, CHUNK_BYTES * 4),
                )
            } catch (e: Exception) {
                Log.w(TAG, "could not create the recorder: ${e.message}")
                return false
            }
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                rec.release()
                return false
            }
            try {
                rec.startRecording()
            } catch (e: Exception) {
                Log.w(TAG, "could not start recording: ${e.message}")
                rec.release()
                return false
            }
            val stop = AtomicBoolean(false)
            stopFlag = stop
            val worker = Thread({ pump(rec, stop) }, "flowcode-audio-capture")
            thread = worker
            worker.start()
            return true
        }
    }

    private fun pump(rec: AudioRecord, stop: AtomicBoolean) {
        val buf = ByteArray(CHUNK_BYTES)
        while (!stop.get()) {
            val n = rec.read(buf, 0, buf.size)
            if (n > 0) {
                emitChunk(buf, n)
            } else if (n < 0) {
                // The recorder died (e.g. another app took the microphone).
                stop.set(true)
                if (stopFlag === stop) stopFlag = null
                fail("capture")
                break
            }
        }
        // Flush what the recorder still holds, so the last words are not cut off.
        try {
            rec.stop()
            while (true) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) break
                emitChunk(buf, n)
            }
        } catch (e: Exception) {
            Log.w(TAG, "flush failed: ${e.message}")
        }
        rec.release()
    }

    /** Stops the capture thread and waits for it, so the flushed chunks are out before we return. */
    private fun endLocked() {
        stopFlag?.set(true)
        stopFlag = null
        val worker = thread
        thread = null
        if (worker != null && worker !== Thread.currentThread()) {
            try {
                worker.join(1500)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }

    private fun end() {
        synchronized(lock) { endLocked() }
    }

    @Command
    fun start(invoke: Invoke) {
        if (granted()) {
            startNow(invoke)
        } else {
            synchronized(pendingPermission) {
                pendingPermission.add(invoke)
                permissionEpochs[invoke] = permissionEpoch.get()
            }
            requestPermissionForAlias(PERMISSION_ALIAS, invoke, "microphonePermissionResult")
        }
    }

    private fun startNow(invoke: Invoke) {
        if (begin()) invoke.resolve() else invoke.reject("capture")
    }

    @PermissionCallback
    fun microphonePermissionResult(invoke: Invoke) {
        val asked = synchronized(pendingPermission) {
            pendingPermission.remove(invoke)
            permissionEpochs.remove(invoke)
        }
        // A stop or cancel during the dialog: the session is gone, do not turn the microphone on.
        if (asked != permissionEpoch.get()) {
            invoke.reject("cancelled")
            return
        }
        if (granted()) startNow(invoke) else invoke.reject("permission")
    }

    /** Stops recording after flushing the last chunk. */
    @Command
    fun stop(invoke: Invoke) {
        permissionEpoch.incrementAndGet()
        end()
        invoke.resolve()
    }

    // A paused app must not keep the microphone: the page cancels its session too.
    override fun onPause() {
        // Only a running capture is ended here, so a request still waiting on the dialog is not invalidated.
        if (stopFlag != null) {
            permissionEpoch.incrementAndGet()
            // The join waits for the flush: keep that off the main thread.
            Thread {
                end()
                fail("paused")
            }.start()
        }
    }

    // The activity can die while the system dialog is up, and the callback
    // never comes: let the caller go, and drop the recorder.
    override fun onDestroy(activity: AppCompatActivity) {
        val waiting = synchronized(pendingPermission) { pendingPermission.toList().also { pendingPermission.clear(); permissionEpochs.clear() } }
        for (invoke in waiting) {
            try {
                invoke.reject("permission")
            } catch (e: Exception) {
                Log.w(TAG, "could not reject a pending permission request: ${e.message}")
            }
        }
        // The join waits for the flush: keep that off the main thread.
        Thread { end() }.start()
    }
}
