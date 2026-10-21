package com.maxmoffa.flowcode.mobile

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "SpeechPlugin"
private const val PERMISSION_ALIAS = "microphone"

@InvokeArg
class StartArgs {
    var language: String? = null
}

/**
 * Voice dictation for the chat box, on the system's speech recognizer. One
 * recognizer at a time; it reports `partial` and `final` text and, when it is
 * over, `end` with why. An error's `message` is a short code (`permission`,
 * `network`, `busy`, `language`, `unknown`) that the page words in its own
 * language.
 */
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = PERMISSION_ALIAS)])
class SpeechPlugin(private val activity: Activity) : Plugin(activity) {
    /** Only touched on the main thread. */
    private var recognizer: SpeechRecognizer? = null

    /** Permission requests whose dialog is still up; see `onDestroy`. */
    private val pendingPermission = mutableListOf<Invoke>()

    private fun granted(): Boolean =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun emit(event: String, text: String) {
        trigger(event, JSObject().apply { put("text", text) })
    }

    private fun end(reason: String, message: String? = null) {
        trigger("end", JSObject().apply {
            put("reason", reason)
            if (message != null) put("message", message)
        })
    }

    private fun bestText(results: Bundle?): String =
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

    private fun release() {
        recognizer?.destroy()
        recognizer = null
    }

    private fun listen(language: String?) {
        release()
        val speech = SpeechRecognizer.createSpeechRecognizer(activity)
        recognizer = speech
        speech.setRecognitionListener(object : RecognitionListener {
            // A recognizer that was replaced or cancelled must stay quiet.
            private fun live() = recognizer === speech

            override fun onPartialResults(partialResults: Bundle?) {
                val text = bestText(partialResults)
                if (live() && text.isNotEmpty()) emit("partial", text)
            }

            override fun onResults(results: Bundle?) {
                if (!live()) return
                val text = bestText(results)
                release()
                if (text.isNotEmpty()) emit("final", text)
                end("stopped")
            }

            override fun onError(error: Int) {
                if (!live()) return
                release()
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> end("silence")
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> end("error", "permission")
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER -> end("error", "network")
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> end("error", "busy")
                    SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> end("error", "language")
                    else -> end("error", "unknown")
                }
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
        if (!language.isNullOrEmpty()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
        try {
            speech.startListening(intent)
        } catch (e: Exception) {
            Log.w(TAG, "could not start listening: ${e.message}")
            release()
            end("error", "unknown")
        }
    }

    @Command
    fun isAvailable(invoke: Invoke) {
        invoke.resolve(JSObject().apply { put("available", SpeechRecognizer.isRecognitionAvailable(activity)) })
    }

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartArgs::class.java)
        if (granted()) {
            activity.runOnUiThread { listen(args.language) }
            invoke.resolve()
        } else {
            synchronized(pendingPermission) { pendingPermission.add(invoke) }
            requestPermissionForAlias(PERMISSION_ALIAS, invoke, "microphonePermissionResult")
        }
    }

    @PermissionCallback
    fun microphonePermissionResult(invoke: Invoke) {
        synchronized(pendingPermission) { pendingPermission.remove(invoke) }
        if (granted()) {
            val args = invoke.parseArgs(StartArgs::class.java)
            activity.runOnUiThread { listen(args.language) }
        } else {
            end("error", "permission")
        }
        invoke.resolve()
    }

    /** Ends the phrase: the recognizer still delivers what it heard so far. */
    @Command
    fun stop(invoke: Invoke) {
        activity.runOnUiThread { recognizer?.stopListening() }
        invoke.resolve()
    }

    /** Drops the session without a result. */
    @Command
    fun cancel(invoke: Invoke) {
        activity.runOnUiThread {
            recognizer?.cancel()
            release()
        }
        invoke.resolve()
    }

    // The activity can die while the system dialog is up, and the callback
    // never comes: let the caller go, and drop the recognizer.
    override fun onDestroy(activity: AppCompatActivity) {
        val waiting = synchronized(pendingPermission) { pendingPermission.toList().also { pendingPermission.clear() } }
        for (invoke in waiting) {
            try {
                invoke.resolve()
            } catch (e: Exception) {
                Log.w(TAG, "could not resolve a pending permission request: ${e.message}")
            }
        }
        release()
    }
}
