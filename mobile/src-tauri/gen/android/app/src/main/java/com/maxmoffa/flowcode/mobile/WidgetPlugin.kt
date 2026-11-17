package com.maxmoffa.flowcode.mobile

import android.app.Activity
import android.content.Intent
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "WidgetPlugin"
private const val EXTRA_ACTION = "widgetAction"
private const val EXTRA_AGENT = "widgetAgent"

@InvokeArg
class WidgetUpdateArgs {
    lateinit var snapshot: String
}

/**
 * Home-screen widgets: stores the stats the widgets draw from, and reports
 * which widget button opened the app (open / new / voice / resume).
 */
@TauriPlugin
class WidgetPlugin(private val activity: Activity) : Plugin(activity) {
    /** Action + agent of the tapped widget button, until the app takes it. */
    @Volatile
    private var pending: Pair<String, String?>? = null

    init {
        readIntent(activity.intent)
    }

    private fun readIntent(intent: Intent?) {
        if (intent?.action != WidgetRender.ACTION) return
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val agent = intent.getStringExtra(EXTRA_AGENT)
        // Consumed: a recreated activity gets the same intent back.
        intent.removeExtra(EXTRA_ACTION)
        intent.removeExtra(EXTRA_AGENT)
        pending = action to agent
    }

    override fun onNewIntent(intent: Intent) {
        readIntent(intent)
    }

    @Command
    fun takeAction(invoke: Invoke) {
        val taken = pending
        pending = null
        invoke.resolve(JSObject().apply {
            if (taken != null) {
                put("action", taken.first)
                taken.second?.let { put("agent", it) }
            }
        })
    }

    @Command
    fun update(invoke: Invoke) {
        val args = invoke.parseArgs(WidgetUpdateArgs::class.java)
        WidgetRender.saveSnapshot(activity, args.snapshot)
        // Drawing every widget's frames takes a moment: answer first, draw on its own thread.
        Thread {
            try {
                WidgetRender.refreshAll(activity)
            } catch (e: Exception) {
                Log.w(TAG, "could not refresh the widgets: ${e.message}")
            }
        }.start()
        invoke.resolve()
    }
}
