package com.maxmoffa.flowcode.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.util.Log
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.Calendar
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

private const val TAG = "WidgetRender"
private const val PREFS = "flowcode_widgets"
private const val KEY_SNAPSHOT = "snapshot"
private const val FRAMES = 8
private const val MAX_SIDE_PX = 1400

/** The three widgets: scene index, dp per scene pixel and default size. */
internal enum class WidgetKind(val scene: Int, val px: Int, val defW: Int, val defH: Int, val provider: Class<*>) {
    FINESTRA(0, 3, 110, 110, FinestraWidget::class.java),
    CANNETO(1, 2, 250, 110, CannetoWidget::class.java),
    STAGNO(2, 3, 250, 110, StagnoWidget::class.java),
}

/** Stats as the app wrote them, already shifted to the real current day. */
private class Snap(val known: Boolean, val days: IntArray, val streak: Int, val minutes: Int, val agents: List<String>) {
    val today get() = days[6]
    val mood get() = if (today == 0) "sleep" else if (today <= 3) "calm" else "happy"
}

private val AGENT_LETTER = mapOf("claude" to "C", "codex" to "X", "gemini" to "G", "opencode" to "O", "vibe" to "V")
private val AGENT_COLOR = mapOf("claude" to "#d98b5f", "codex" to "#8fb0d6", "gemini" to "#c9b36a", "opencode" to "#b9a2d8", "vibe" to "#e0a46a")

internal object WidgetRender {
    const val ACTION = "com.maxmoffa.flowcode.mobile.WIDGET"

    // ---- data ----
    fun saveSnapshot(ctx: Context, json: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SNAPSHOT, json).apply()
    }

    private fun midnight(): Long = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    private fun loadSnap(ctx: Context): Snap {
        val empty = Snap(false, IntArray(7), 0, 0, listOf("claude", "codex"))
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SNAPSHOT, null) ?: return empty
        return try {
            val o = JSONObject(raw)
            if (o.optInt("v") != 1) return empty
            val arr = o.optJSONArray("days") ?: return empty
            val old = IntArray(7) { arr.optInt(it, 0) }
            // The snapshot may be a few days old: align it to the real today.
            val shift = max(0, Math.round((midnight() - o.optLong("dayStart")) / 86_400_000.0).toInt())
            val days = IntArray(7) { if (it + shift < 7) old[it + shift] else 0 }
            val streak = o.optInt("streak")
            val agents = o.optJSONArray("agents")?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotEmpty() }.take(4) }.orEmpty()
            Snap(
                true, days,
                if (shift == 0 || (shift == 1 && old[6] > 0)) streak else 0,
                if (shift == 0) o.optInt("todayMinutes") else 0,
                agents.ifEmpty { listOf("claude", "codex") },
            )
        } catch (e: Exception) {
            Log.w(TAG, "bad snapshot: ${e.message}")
            empty
        }
    }

    // ---- size ----
    /** Current size in dp, from the launcher's options. */
    private fun sizeDp(ctx: Context, opts: android.os.Bundle, kind: WidgetKind): Pair<Int, Int> {
        var w = 0
        var h = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            @Suppress("DEPRECATION")
            val sizes = opts.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES)
            sizes?.firstOrNull()?.let { w = it.width.toInt(); h = it.height.toInt() }
        }
        if (w <= 0 || h <= 0) {
            val portrait = ctx.resources.configuration.orientation != android.content.res.Configuration.ORIENTATION_LANDSCAPE
            val minW = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
            val maxW = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH)
            val minH = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)
            val maxH = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
            w = if (portrait) minW else maxW
            h = if (portrait) maxH else minH
        }
        return (if (w > 0) w else kind.defW) to (if (h > 0) h else kind.defH)
    }

    // ---- frames ----
    private fun framesDir(ctx: Context, id: Int) = File(ctx.filesDir, "widgets/$id")

    private fun renderFrames(ctx: Context, kind: WidgetKind, id: Int, wDp: Int, hDp: Int, snap: Snap): List<Uri> {
        val w = max(1, ceil(wDp.toDouble() / kind.px).toInt())
        val h = max(1, ceil(hDp.toDouble() / kind.px).toInt())
        val widthPx = wDp * ctx.resources.displayMetrics.density
        var k = max(1, ceil(widthPx / w).toInt())
        while (k > 1 && max(w, h) * k > MAX_SIDE_PX) k--
        val now = Calendar.getInstance()
        val letters = if (kind == WidgetKind.CANNETO) {
            WidgetArt.dayLetters(Locale.getDefault().language == "it", (now.get(Calendar.DAY_OF_WEEK) + 5) % 7)
        } else null
        val data = SceneData(snap.mood, snap.days, snap.today)
        val hour = now.get(Calendar.HOUR_OF_DAY)
        val dir = framesDir(ctx, id).apply { mkdirs() }
        val gen = System.currentTimeMillis()
        val uris = ArrayList<Uri>(FRAMES)
        for (i in 0 until FRAMES) {
            val low = WidgetArt.render(kind.scene, w, h, i / 4.0, hour, data, letters)
            // Nearest neighbour keeps the pixels square.
            val big = Bitmap.createScaledBitmap(low, w * k, h * k, false)
            val name = "${gen}_$i.png"
            FileOutputStream(File(dir, name)).use { big.compress(Bitmap.CompressFormat.PNG, 100, it) }
            low.recycle()
            if (big !== low) big.recycle()
            uris.add(Uri.Builder().scheme("content").authority(ctx.packageName + ".widgetframes").appendPath(id.toString()).appendPath(name).build())
        }
        prune(dir, gen)
        return uris
    }

    // Keeps the new generation and the previous one: the launcher may still be
    // loading the old URIs while it swaps in the new views.
    private fun prune(dir: File, current: Long) {
        val files = dir.listFiles() ?: return
        val gens = files.mapNotNull { it.name.substringBefore('_').toLongOrNull() }.distinct().filter { it != current }.sortedDescending()
        val keep = setOfNotNull(current, gens.firstOrNull())
        for (f in files) {
            val g = f.name.substringBefore('_').toLongOrNull()
            if (g == null || g !in keep) f.delete()
        }
    }

    fun deleteFrames(ctx: Context, ids: IntArray) {
        for (id in ids) framesDir(ctx, id).deleteRecursively()
    }

    // ---- views ----
    private fun pending(ctx: Context, id: Int, index: Int, action: String, agent: String? = null): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java)
            .setAction(ACTION)
            .putExtra("widgetAction", action)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (agent != null) intent.putExtra("widgetAgent", agent)
        // Distinct request code per button: extras are not part of PendingIntent identity.
        return PendingIntent.getActivity(ctx, id * 16 + index, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun RemoteViews.show(viewId: Int, on: Boolean) = setViewVisibility(viewId, if (on) View.VISIBLE else View.GONE)

    private val FRAME_IDS = intArrayOf(R.id.f0, R.id.f1, R.id.f2, R.id.f3, R.id.f4, R.id.f5, R.id.f6, R.id.f7)

    private fun timeText(ctx: Context, minutes: Int) = ctx.getString(R.string.widget_time_today, "${minutes / 60} h %02d".format(minutes % 60))

    private fun build(ctx: Context, kind: WidgetKind, id: Int, w: Int, h: Int, snap: Snap, uris: List<Uri>): RemoteViews {
        val layout = when (kind) {
            WidgetKind.FINESTRA -> R.layout.widget_finestra
            WidgetKind.CANNETO -> R.layout.widget_canneto
            WidgetKind.STAGNO -> R.layout.widget_stagno
        }
        val rv = RemoteViews(ctx.packageName, layout)
        uris.forEachIndexed { i, u -> rv.setImageViewUri(FRAME_IDS[i], u) }
        rv.setOnClickPendingIntent(R.id.root, pending(ctx, id, 0, "open"))
        rv.setOnClickPendingIntent(R.id.chip, pending(ctx, id, 1, "open"))
        when (kind) {
            WidgetKind.FINESTRA -> buildFinestra(ctx, rv, id, w, h, snap)
            WidgetKind.CANNETO -> buildCanneto(ctx, rv, id, w, h, snap)
            WidgetKind.STAGNO -> buildStagno(ctx, rv, id, w, h, snap)
        }
        return rv
    }

    private fun buildFinestra(ctx: Context, rv: RemoteViews, id: Int, w: Int, h: Int, snap: Snap) {
        val streak = snap.streak
        rv.setTextViewText(R.id.chip_num, if (streak > 0) streak.toString() else "–")
        rv.setTextViewText(R.id.chip_label, ctx.getString(if (!snap.known) R.string.widget_open else if (streak > 0) R.string.widget_days_in_row else R.string.widget_start_today))
        rv.show(R.id.chip, !(w < 80 && h < 80))
        rv.show(R.id.chip_label, !(w < 110 || h < 110))
        // Wide and short: the buttons sit in a row instead of a column.
        val row = w >= 170 && h < 130
        rv.show(R.id.col, !row)
        rv.show(R.id.btn_row, row)
        rv.show(R.id.mic, !(h < 110 || w < 90))
        rv.setOnClickPendingIntent(R.id.mic, pending(ctx, id, 2, "voice"))
        rv.setOnClickPendingIntent(R.id.fab, pending(ctx, id, 3, "new"))
        rv.setOnClickPendingIntent(R.id.mic_r, pending(ctx, id, 4, "voice"))
        rv.setOnClickPendingIntent(R.id.fab_r, pending(ctx, id, 5, "new"))
    }

    private fun buildCanneto(ctx: Context, rv: RemoteViews, id: Int, w: Int, h: Int, snap: Snap) {
        rv.setTextViewText(R.id.chip_num, if (snap.known) snap.days.sum().toString() else "–")
        rv.setTextViewText(R.id.chip_label, ctx.getString(if (snap.known) R.string.widget_sessions_week else R.string.widget_open))
        rv.setTextViewText(R.id.chip_mono, timeText(ctx, snap.minutes))
        rv.show(R.id.chip_mono, snap.known && h >= 100)
        rv.show(R.id.chip_label, h >= 80)
        val fabNew = w < 200
        rv.show(R.id.new_pill, !fabNew)
        rv.show(R.id.new_fab, fabNew)
        rv.show(R.id.resume_pill, w >= 230)
        rv.show(R.id.resume_round, w in 160..229)
        rv.setOnClickPendingIntent(R.id.new_pill, pending(ctx, id, 2, "new"))
        rv.setOnClickPendingIntent(R.id.new_fab, pending(ctx, id, 3, "new"))
        rv.setOnClickPendingIntent(R.id.resume_pill, pending(ctx, id, 4, "resume"))
        rv.setOnClickPendingIntent(R.id.resume_round, pending(ctx, id, 5, "resume"))
    }

    private fun buildStagno(ctx: Context, rv: RemoteViews, id: Int, w: Int, h: Int, snap: Snap) {
        rv.setTextViewText(R.id.chip_num, if (snap.known) snap.today.toString() else "–")
        rv.setTextViewText(R.id.chip_label, ctx.getString(if (!snap.known) R.string.widget_open else if (snap.today == 1) R.string.widget_session_today else R.string.widget_sessions_today))
        rv.setTextViewText(R.id.chip_mono, timeText(ctx, snap.minutes))
        rv.show(R.id.chip_mono, snap.known && h >= 100)
        rv.show(R.id.chip_label, h >= 80)
        val room = if (w < 150) 0 else max(0, min(floor((w - 20 - 38 - 6) / 36.0).toInt(), snap.agents.size))
        val ids = intArrayOf(R.id.ag0, R.id.ag1, R.id.ag2, R.id.ag3)
        ids.forEachIndexed { i, viewId ->
            val agent = snap.agents.getOrNull(i)
            val on = i < room && agent != null
            rv.show(viewId, on)
            if (on && agent != null) {
                rv.setTextViewText(viewId, AGENT_LETTER[agent] ?: agent.take(1).uppercase())
                rv.setTextColor(viewId, android.graphics.Color.parseColor(AGENT_COLOR[agent] ?: "#fff6ea"))
                rv.setContentDescription(viewId, agent)
                rv.setOnClickPendingIntent(viewId, pending(ctx, id, 2 + i, "new", agent))
            }
        }
        rv.setOnClickPendingIntent(R.id.fab, pending(ctx, id, 6, "new"))
    }

    // ---- entry points ----
    @Synchronized
    fun updateOne(ctx: Context, mgr: AppWidgetManager, kind: WidgetKind, id: Int) {
        try {
            val (w, h) = sizeDp(ctx, mgr.getAppWidgetOptions(id), kind)
            val snap = loadSnap(ctx)
            val uris = renderFrames(ctx, kind, id, w, h, snap)
            mgr.updateAppWidget(id, build(ctx, kind, id, w, h, snap, uris))
        } catch (e: Exception) {
            Log.w(TAG, "could not update widget $id: ${e.message}")
        }
    }

    /** Renders off the main thread; `pending` (from `goAsync()`) keeps the receiver alive. */
    fun updateAsync(ctx: Context, kind: WidgetKind, ids: IntArray, pending: BroadcastReceiver.PendingResult?) {
        val app = ctx.applicationContext
        Thread {
            try {
                val mgr = AppWidgetManager.getInstance(app)
                for (id in ids) updateOne(app, mgr, kind, id)
            } finally {
                pending?.finish()
            }
        }.start()
    }

    /** After new stats from the app: every instance of every provider. */
    fun refreshAll(ctx: Context) {
        val app = ctx.applicationContext
        val mgr = AppWidgetManager.getInstance(app)
        for (kind in WidgetKind.values()) {
            for (id in mgr.getAppWidgetIds(ComponentName(app, kind.provider))) updateOne(app, mgr, kind, id)
        }
    }
}
