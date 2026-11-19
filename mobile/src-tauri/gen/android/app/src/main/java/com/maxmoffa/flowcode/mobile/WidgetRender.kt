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
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

private const val TAG = "WidgetRender"
private const val PREFS = "flowcode_widgets"
private const val KEY_SNAPSHOT = "snapshot"
// 24 frames over the same 2 s loop: ~12 fps (the flippers flip every 83 ms).
private const val FRAMES = 24
private const val FPS = 12.0
// Launcher memory: every widget keeps ~24 decoded frames, so cap their side at 800 px.
private const val MAX_SIDE_PX = 800

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

/** Each agent's mark (generated from shared/agentLogos.ts), already in its colour. */
private val AGENT_ICON = mapOf(
    "claude" to R.drawable.widget_agent_claude,
    "codex" to R.drawable.widget_agent_codex,
    "gemini" to R.drawable.widget_agent_gemini,
    "opencode" to R.drawable.widget_agent_opencode,
    "vibe" to R.drawable.widget_agent_vibe,
)

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
        // Stored at about half the screen resolution and enlarged by the launcher:
        // three times the frames of 0.35 for about the same memory.
        var k = max(1, ceil(ceil(widthPx / w) / 2.0).toInt())
        while (k > 1 && max(w, h) * k > MAX_SIDE_PX) k--
        val now = Calendar.getInstance()
        val data = SceneData(snap.mood, snap.days, snap.today)
        val hour = now.get(Calendar.HOUR_OF_DAY)
        val dir = framesDir(ctx, id).apply { mkdirs() }
        val gen = System.currentTimeMillis()
        val uris = ArrayList<Uri>(FRAMES)
        for (i in 0 until FRAMES) {
            val low = WidgetArt.render(kind.scene, w, h, i / FPS, hour, data, null)
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
        for (id in ids) { tickets.remove(id); rendered.remove(id) }
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

    /** What tapping the app icon does: brings Flowcode up where it was, with no widget action. */
    private fun openApp(ctx: Context, id: Int): PendingIntent {
        val intent = (ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: Intent(ctx, MainActivity::class.java))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(ctx, id * 16, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun RemoteViews.show(viewId: Int, on: Boolean) = setViewVisibility(viewId, if (on) View.VISIBLE else View.GONE)

    private val FRAME_IDS = intArrayOf(
        R.id.f0, R.id.f1, R.id.f2, R.id.f3, R.id.f4, R.id.f5, R.id.f6, R.id.f7,
        R.id.f8, R.id.f9, R.id.f10, R.id.f11, R.id.f12, R.id.f13, R.id.f14, R.id.f15,
        R.id.f16, R.id.f17, R.id.f18, R.id.f19, R.id.f20, R.id.f21, R.id.f22, R.id.f23,
    )

    /** The number on the scene and its label; the label goes on small sizes. */
    private fun stat(ctx: Context, rv: RemoteViews, w: Int, h: Int, num: String, label: Int) {
        rv.setTextViewText(R.id.stat_num, num)
        rv.setTextViewText(R.id.stat_label, ctx.getString(label))
        rv.show(R.id.stat, !(w < 80 && h < 80))
        rv.show(R.id.scrim, !(w < 80 && h < 80))
        rv.show(R.id.stat_label, w >= 100 && h >= 90)
    }

    private fun build(ctx: Context, kind: WidgetKind, id: Int, w: Int, h: Int, snap: Snap, uris: List<Uri>): RemoteViews {
        val layout = when (kind) {
            WidgetKind.FINESTRA -> R.layout.widget_finestra
            WidgetKind.CANNETO -> R.layout.widget_canneto
            WidgetKind.STAGNO -> R.layout.widget_stagno
        }
        val rv = RemoteViews(ctx.packageName, layout)
        uris.forEachIndexed { i, u -> rv.setImageViewUri(FRAME_IDS[i], u) }
        // Everything that is not a new-chat button just opens the app.
        rv.setOnClickPendingIntent(R.id.root, openApp(ctx, id))
        when (kind) {
            WidgetKind.FINESTRA -> buildFinestra(ctx, rv, id, w, h, snap)
            WidgetKind.CANNETO -> buildCanneto(ctx, rv, id, w, h, snap)
            WidgetKind.STAGNO -> buildStagno(ctx, rv, id, w, h, snap)
        }
        return rv
    }

    private fun buildFinestra(ctx: Context, rv: RemoteViews, id: Int, w: Int, h: Int, snap: Snap) {
        val streak = snap.streak
        val label = if (!snap.known) R.string.widget_open else if (streak == 1) R.string.widget_day_in_row else if (streak > 1) R.string.widget_days_in_row else R.string.widget_start_today
        stat(ctx, rv, w, h, if (snap.known) streak.toString() else "–", label)
        rv.setOnClickPendingIntent(R.id.fab, pending(ctx, id, 1, "new"))
    }

    private fun buildCanneto(ctx: Context, rv: RemoteViews, id: Int, w: Int, h: Int, snap: Snap) {
        stat(ctx, rv, w, h, if (snap.known) snap.days.sum().toString() else "–", if (snap.known) R.string.widget_sessions_7_days else R.string.widget_open)
        // Narrow: the round + instead of the "New chat" pill.
        val narrow = w < 200
        rv.show(R.id.new_pill, !narrow)
        rv.show(R.id.row, narrow)
        rv.setOnClickPendingIntent(R.id.new_pill, pending(ctx, id, 1, "new"))
        rv.setOnClickPendingIntent(R.id.fab, pending(ctx, id, 2, "new"))
    }

    private fun buildStagno(ctx: Context, rv: RemoteViews, id: Int, w: Int, h: Int, snap: Snap) {
        val label = if (!snap.known) R.string.widget_open else if (snap.today == 1) R.string.widget_session_today else R.string.widget_sessions_today
        stat(ctx, rv, w, h, if (snap.known) snap.today.toString() else "–", label)
        // An agent without a mark here (a newer one) gets no button.
        val agents = snap.agents.filter { it in AGENT_ICON }
        val room = if (w < 150) 0 else max(0, min(floor((w - 20 - 36) / 38.0).toInt(), min(3, agents.size)))
        val ids = intArrayOf(R.id.ag0, R.id.ag1, R.id.ag2)
        ids.forEachIndexed { i, viewId ->
            val agent = agents.getOrNull(i)
            val on = i < room && agent != null
            rv.show(viewId, on)
            if (on && agent != null) {
                rv.setImageViewResource(viewId, AGENT_ICON.getValue(agent))
                rv.setContentDescription(viewId, agent)
                rv.setOnClickPendingIntent(viewId, pending(ctx, id, 2 + i, "new", agent))
            }
        }
        rv.setOnClickPendingIntent(R.id.fab, pending(ctx, id, 6, "new"))
    }

    // ---- entry points ----
    // One background thread renders everything, so a burst of resizes or
    // updates queues up instead of running in parallel; per widget id only the
    // latest request does any work.
    private val executor = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "widget-render").apply { isDaemon = true } }
    private val tickets = java.util.concurrent.ConcurrentHashMap<Int, Long>()
    private val ticketSeq = java.util.concurrent.atomic.AtomicLong()

    /** What the last render of a widget was drawn from: unchanged inputs reuse its frames. */
    private class Rendered(val key: String, val uris: List<Uri>)
    private val rendered = java.util.concurrent.ConcurrentHashMap<Int, Rendered>()

    private fun updateOne(ctx: Context, mgr: AppWidgetManager, kind: WidgetKind, id: Int) {
        try {
            val (w, h) = sizeDp(ctx, mgr.getAppWidgetOptions(id), kind)
            val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SNAPSHOT, null)
            val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
            // The snapshot is shifted to the real day, so the day belongs in the key too.
            val key = "${kind.name}|$w|$h|$hour|${midnight()}|${ctx.resources.displayMetrics.density}|$raw"
            val snap = loadSnap(ctx)
            val prev = rendered[id]
            val uris = if (prev != null && prev.key == key && frameFilesExist(ctx, id, prev.uris)) prev.uris
            else renderFrames(ctx, kind, id, w, h, snap).also { rendered[id] = Rendered(key, it) }
            mgr.updateAppWidget(id, build(ctx, kind, id, w, h, snap, uris))
        } catch (e: Exception) {
            Log.w(TAG, "could not update widget $id: ${e.message}")
        }
    }

    private fun frameFilesExist(ctx: Context, id: Int, uris: List<Uri>): Boolean {
        val dir = framesDir(ctx, id)
        return uris.all { u -> u.lastPathSegment?.let { File(dir, it).exists() } == true }
    }

    private fun enqueue(app: Context, kind: WidgetKind, ids: IntArray, done: (() -> Unit)?) {
        val mine = ids.associateWith { ticketSeq.incrementAndGet().also { t -> tickets[it] = t } }
        executor.execute {
            try {
                val mgr = AppWidgetManager.getInstance(app)
                for (id in ids) {
                    if (tickets[id] != mine[id]) continue // a newer request for this widget is queued
                    updateOne(app, mgr, kind, id)
                }
            } finally {
                done?.invoke()
            }
        }
    }

    /** Renders off the main thread; `pending` (from `goAsync()`) keeps the receiver alive. */
    fun updateAsync(ctx: Context, kind: WidgetKind, ids: IntArray, pending: BroadcastReceiver.PendingResult?) {
        enqueue(ctx.applicationContext, kind, ids) { pending?.finish() }
    }

    /** After new stats from the app: every instance of every provider. */
    fun refreshAll(ctx: Context) {
        val app = ctx.applicationContext
        val mgr = AppWidgetManager.getInstance(app)
        for (kind in WidgetKind.values()) {
            val ids = mgr.getAppWidgetIds(ComponentName(app, kind.provider))
            if (ids.isNotEmpty()) enqueue(app, kind, ids, null)
        }
    }
}
