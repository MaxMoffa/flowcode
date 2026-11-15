package com.maxmoffa.flowcode.mobile

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle

/** Shared plumbing of the three widgets; each subclass only names its kind. */
abstract class WidgetProviderBase internal constructor(private val kind: WidgetKind) : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        WidgetRender.updateAsync(context, kind, ids, goAsync())
    }

    // Resizing: the frames are drawn for the new size and the buttons re-laid out.
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, newOptions: Bundle) {
        WidgetRender.updateAsync(context, kind, intArrayOf(id), goAsync())
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        WidgetRender.deleteFrames(context, ids)
    }
}

/** A: Finestra, 2x2. */
class FinestraWidget : WidgetProviderBase(WidgetKind.FINESTRA)
