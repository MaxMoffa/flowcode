package com.maxmoffa.flowcode.mobile

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/** Shared plumbing of the three widgets; each subclass only names its kind. */
abstract class WidgetProviderBase internal constructor(private val kind: WidgetKind) : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        WidgetRender.updateAsync(context, kind, ids, goAsync())
    }

    // Resizing: the frames are drawn for the new size and the buttons re-laid out. A drag fires this
    // on every step, so only the last size of a burst (300 ms quiet) is rendered.
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, newOptions: Bundle) {
        val app = context.applicationContext
        resizes.remove(id)?.let { handler.removeCallbacks(it) }
        val run = Runnable {
            resizes.remove(id)
            WidgetRender.updateAsync(app, kind, intArrayOf(id), null)
        }
        resizes[id] = run
        handler.postDelayed(run, 300L)
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        for (id in ids) resizes.remove(id)?.let { handler.removeCallbacks(it) }
        WidgetRender.deleteFrames(context, ids)
    }

    private companion object {
        // Main thread only (receivers run there).
        val handler = Handler(Looper.getMainLooper())
        val resizes = HashMap<Int, Runnable>()
    }
}

/** A: Finestra, 2x2. */
class FinestraWidget : WidgetProviderBase(WidgetKind.FINESTRA)
