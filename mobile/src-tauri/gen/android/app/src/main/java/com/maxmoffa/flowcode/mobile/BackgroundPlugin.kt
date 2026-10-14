package com.maxmoffa.flowcode.mobile

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "BackgroundPlugin"
private const val PERMISSION_ALIAS = "notifications"

@InvokeArg
class ArmArgs {
    var armed: Boolean = false
    var title: String = ""
    var text: String = ""
    var capMinutes: Int = 0
}

@InvokeArg
class NotifyArgs {
    lateinit var title: String
    lateinit var body: String
    var tabId: String? = null
}

/**
 * "Stay connected in the background": while armed, pausing the app starts
 * `ConnectionService` (so the link to the PC survives) and resuming stops it.
 * Also posts the PC's agent notifications and reports which tab a tapped
 * notification was about.
 */
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = PERMISSION_ALIAS)])
class BackgroundPlugin(private val activity: Activity) : Plugin(activity) {
    private var armed = false
    private var title = ""
    private var text = ""
    private var capMinutes = 0
    private val nextId = AtomicInteger(1000)

    /** Permission requests whose dialog is still up; see `onDestroy`. */
    private val pendingPermission = mutableListOf<Invoke>()

    /** Tab of the notification that opened the app, until the app takes it. */
    @Volatile
    private var pendingTab: String? = null

    init {
        ensureChannels(activity)
        takeTab(activity.intent)
    }

    private fun takeTab(intent: Intent?) {
        val tab = intent?.getStringExtra(EXTRA_TAB_ID) ?: return
        // Consumed: a recreated activity gets the same intent back.
        intent.removeExtra(EXTRA_TAB_ID)
        pendingTab = tab
    }

    private fun granted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun grantedReply() = JSObject().apply { put("granted", granted()) }

    override fun onNewIntent(intent: Intent) {
        takeTab(intent)
    }

    // Still in the foreground here, which is what lets Android 12+ start a
    // foreground service.
    override fun onPause(activity: AppCompatActivity) {
        if (!armed) return
        val intent = Intent(activity, ConnectionService::class.java)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_TEXT, text)
            .putExtra(EXTRA_CAP_MINUTES, capMinutes)
        try {
            ContextCompat.startForegroundService(activity, intent)
        } catch (e: Exception) {
            Log.w(TAG, "could not start the connection service: ${e.message}")
        }
    }

    override fun onResume(activity: AppCompatActivity) {
        try {
            activity.stopService(Intent(activity, ConnectionService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "could not stop the connection service: ${e.message}")
        }
    }

    @Command
    fun setArmed(invoke: Invoke) {
        val args = invoke.parseArgs(ArmArgs::class.java)
        armed = args.armed
        title = args.title
        text = args.text
        capMinutes = args.capMinutes
        invoke.resolve()
    }

    @Command
    fun notify(invoke: Invoke) {
        val args = invoke.parseArgs(NotifyArgs::class.java)
        if (!granted()) {
            invoke.resolve()
            return
        }
        try {
            val id = nextId.getAndIncrement()
            val notification = NotificationCompat.Builder(activity, CHANNEL_AGENTS)
                .setSmallIcon(R.mipmap.ic_launcher_monochrome)
                .setContentTitle(args.title)
                .setContentText(args.body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(args.body))
                .setContentIntent(openAppIntent(activity, id, args.tabId))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .build()
            activity.getSystemService(NotificationManager::class.java).notify(id, notification)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Notify failed: ${e.message}")
        }
    }

    /** The tab a tapped notification was about, once; `{}` when there is none. */
    @Command
    fun takePendingTab(invoke: Invoke) {
        val tab = pendingTab
        pendingTab = null
        invoke.resolve(JSObject().apply { if (tab != null) put("tabId", tab) })
    }

    @Command
    fun notificationPermission(invoke: Invoke) {
        invoke.resolve(grantedReply())
    }

    @Command
    fun requestNotificationPermission(invoke: Invoke) {
        if (granted()) {
            invoke.resolve(grantedReply())
        } else {
            synchronized(pendingPermission) { pendingPermission.add(invoke) }
            requestPermissionForAlias(PERMISSION_ALIAS, invoke, "notificationPermissionResult")
        }
    }

    @PermissionCallback
    fun notificationPermissionResult(invoke: Invoke) {
        synchronized(pendingPermission) { pendingPermission.remove(invoke) }
        invoke.resolve(grantedReply())
    }

    // The activity can die while the system dialog is up, and the callback
    // never comes: answer with the current state so the caller is not left
    // blocked forever.
    override fun onDestroy(activity: AppCompatActivity) {
        val waiting = synchronized(pendingPermission) { pendingPermission.toList().also { pendingPermission.clear() } }
        for (invoke in waiting) {
            try {
                invoke.resolve(grantedReply())
            } catch (e: Exception) {
                Log.w(TAG, "could not resolve a pending permission request: ${e.message}")
            }
        }
    }
}
