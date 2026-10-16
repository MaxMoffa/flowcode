package com.maxmoffa.flowcode.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

private const val TAG = "ConnectionService"
private const val ONGOING_ID = 1
const val CHANNEL_CONNECTION = "connection"
const val CHANNEL_AGENTS = "agents"
const val EXTRA_TAB_ID = "tabId"
const val EXTRA_TITLE = "title"
const val EXTRA_TEXT = "text"
const val EXTRA_CAP_MINUTES = "capMinutes"
/** The ongoing notification's "turn off for now" button. */
private const val ACTION_PAUSE = "com.maxmoffa.flowcode.mobile.PAUSE_BACKGROUND"

/** Creates the notification channels (idempotent; they only exist on API 26+). */
fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
        NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_LOW)
    )
    manager.createNotificationChannel(
        NotificationChannel(CHANNEL_AGENTS, context.getString(R.string.channel_agents), NotificationManager.IMPORTANCE_HIGH)
    )
}

/** Opens the app, optionally on the tab a notification is about. */
fun openAppIntent(context: Context, requestCode: Int, tabId: String?): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        if (tabId != null) putExtra(EXTRA_TAB_ID, tabId)
    }
    return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
}

/**
 * Keeps the process, and so the iroh link to the PC, alive while the app is in
 * the background. Started by `BackgroundPlugin` when the app is paused with
 * the mode armed, stopped when the app comes back, after the cap, or from the
 * notification's button. The mode stays armed, so leaving the app again
 * starts it again.
 */
class ConnectionService : Service() {
    private val handler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_PAUSE) {
            stopSelf()
            return START_NOT_STICKY
        }
        ensureChannels(this)
        val pause = PendingIntent.getService(
            this,
            1,
            Intent(this, ConnectionService::class.java).setAction(ACTION_PAUSE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_CONNECTION)
            .setSmallIcon(R.mipmap.ic_launcher_monochrome)
            .setContentTitle(intent?.getStringExtra(EXTRA_TITLE) ?: getString(R.string.app_name))
            .setContentText(intent?.getStringExtra(EXTRA_TEXT) ?: "")
            .setContentIntent(openAppIntent(this, 0, null))
            .addAction(0, getString(R.string.background_pause), pause)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        try {
            // specialUse only exists from API 34; older versions take no type.
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
            ServiceCompat.startForeground(this, ONGOING_ID, notification, type)
        } catch (e: Exception) {
            Log.w(TAG, "could not go foreground: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }
        handler.removeCallbacksAndMessages(null)
        val capMinutes = intent?.getIntExtra(EXTRA_CAP_MINUTES, 0) ?: 0
        if (capMinutes > 0) {
            handler.postDelayed({ stopSelf() }, capMinutes * 60_000L)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
