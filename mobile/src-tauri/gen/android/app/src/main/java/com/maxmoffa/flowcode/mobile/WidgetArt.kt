package com.maxmoffa.flowcode.mobile

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

// Port of the pixel-art scenes in docs/design/mobile-widgets-variants.html.
// Everything is drawn on a tiny bitmap with no antialiasing and integer rects:
// the render step then scales it up with nearest neighbour.

/** JS `Math.round`: halves go up, so the output matches the artifact. */
internal fun rd(x: Double): Int = floor(x + 0.5).toInt()

private fun rgb(c: Int) = intArrayOf((c shr 16) and 255, (c shr 8) and 255, c and 255)
private fun packRgb(r: Int, g: Int, b: Int) = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

internal fun mix(a: Int, b: Int, f: Double): Int {
    val x = rgb(a)
    val y = rgb(b)
    return packRgb(rd(x[0] + (y[0] - x[0]) * f), rd(x[1] + (y[1] - x[1]) * f), rd(x[2] + (y[2] - x[2]) * f))
}

internal fun hex(s: String): Int = Color.parseColor(s)

/** Deterministic noise, so stars and clouds sit in the same place every frame. */
internal fun rnd(i: Number): Double {
    val x = sin(i.toDouble() * 127.1 + 311.7) * 43758.5453
    return x - floor(x)
}

/** Drawing surface: a small bitmap with an artifact-like `globalAlpha`. */
internal class Pix(val bmp: Bitmap) {
    private val canvas = Canvas(bmp)
    private val paint = Paint().apply { isAntiAlias = false; isFilterBitmap = false; isDither = false }
    private val multiplyPaint = Paint().apply { isAntiAlias = false; xfermode = PorterDuffXfermode(PorterDuff.Mode.MULTIPLY) }
    var alpha = 1.0

    /** Filled rect with rounded origin; fractional sizes round their far edge. */
    fun p(x: Number, y: Number, w: Number, h: Number, col: Int) {
        val l = rd(x.toDouble())
        val t = rd(y.toDouble())
        val r = if (w is Int) l + w else rd(x.toDouble() + w.toDouble())
        val b = if (h is Int) t + h else rd(y.toDouble() + h.toDouble())
        if (r <= l || b <= t) return
        paint.style = Paint.Style.FILL
        paint.color = col
        paint.alpha = rd(alpha * 255)
        canvas.drawRect(l.toFloat(), t.toFloat(), r.toFloat(), b.toFloat(), paint)
    }

    fun image(src: Bitmap, x: Int, y: Int) {
        paint.alpha = 255
        canvas.drawBitmap(src, x.toFloat(), y.toFloat(), paint)
    }

    fun sprite(src: Bitmap, x: Int, y: Int, w: Int, h: Int) {
        paint.alpha = 255
        canvas.drawBitmap(src, Rect(0, 0, src.width, src.height), Rect(x, y, x + w, y + h), paint)
    }

    fun multiply(w: Int, h: Int, col: Int) {
        multiplyPaint.color = col
        canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), multiplyPaint)
    }

    fun line(x0: Double, y0: Double, x1: Double, y1: Double, col: Int) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1f
        paint.color = col
        paint.alpha = rd(alpha * 255)
        canvas.drawLine(x0.toFloat(), y0.toFloat(), x1.toFloat(), y1.toFloat(), paint)
    }

    fun ellipseStroke(cx: Double, cy: Double, rx: Double, ry: Double, col: Int) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1f
        paint.color = col
        paint.alpha = rd(alpha * 255)
        canvas.drawOval(android.graphics.RectF((cx - rx).toFloat(), (cy - ry).toFloat(), (cx + rx).toFloat(), (cy + ry).toFloat()), paint)
    }

    fun disc(cx: Number, cy: Number, r: Int, col: Int) {
        for (y in -r..r) {
            val hw = floor(sqrt((r * r - y * y).toDouble()) + .3).toInt()
            p(rd(cx.toDouble() - hw), rd(cy.toDouble() + y), hw * 2 + 1, 1, col)
        }
    }

    fun oval(cx: Number, cy: Number, rx: Int, ry: Int, col: Int) {
        for (y in -ry..ry) {
            val hw = floor(rx * sqrt(1 - (y * y).toDouble() / (ry * ry + .01)) + .3).toInt()
            p(rd(cx.toDouble() - hw), rd(cy.toDouble() + y), hw * 2 + 1, 1, col)
        }
    }
}

/** One time-of-day palette. */
internal class Pal(
    val top: Int, val bot: Int, val far: Int, val near: Int, val ground: Int, val water: Int, val water2: Int,
    val sun: Int, val cloud: Int, val reed: Int, val tint: Int?, val stars: Double,
    val sunX: Double, val sunY: Double, val moon: Boolean = false,
)

internal class SceneData(val mood: String, val week: IntArray, val today: Int)

internal object WidgetArt {
    val ACCENT = hex("#9db984")
    private const val COLS = 30
    private const val ROWS = 24

    // ---- palettes ----
    private val ALBA = Pal(hex("#e48f78"), hex("#fbe1bb"), hex("#c48d80"), hex("#6f8a55"), hex("#4c6a3b"), hex("#a6c0b6"), hex("#5f8a80"), hex("#fff0c4"), hex("#fdd8c6"), hex("#6c8a4c"), hex("#ffe6d6"), 0.0, .22, .5)
    private val GIORNO = Pal(hex("#6cb0d6"), hex("#d4ecdc"), hex("#8bb490"), hex("#5b8f4d"), hex("#3d6a36"), hex("#6aa89d"), hex("#3a6e66"), hex("#fff6d2"), hex("#f6fbff"), hex("#5f8a45"), null, 0.0, .74, .17)
    private val TRAMONTO = Pal(hex("#4a3a6c"), hex("#f2a35e"), hex("#8a5a6a"), hex("#4b593b"), hex("#33422b"), hex("#7c5f7c"), hex("#3c3350"), hex("#ffc27a"), hex("#e99d8d"), hex("#4a5a36"), hex("#f6d6c8"), .35, .8, .5)
    private val NOTTE = Pal(hex("#0a1226"), hex("#2a3d62"), hex("#1c2944"), hex("#14221e"), hex("#0e1915"), hex("#1c2e46"), hex("#0d1727"), hex("#f2ebd2"), hex("#2d3c5c"), hex("#1f3226"), hex("#8494c6"), 1.0, .74, .2, true)

    /** Same hours as the artifact's autoSlot(). */
    fun slotFor(hour: Int): Pal = when {
        hour in 5..7 -> ALBA
        hour in 8..16 -> GIORNO
        hour in 17..19 -> TRAMONTO
        else -> NOTTE
    }

    // ---- frog palette, derived from the accent like frogArt.ts ----
    private fun hexToHsl(c: Int): DoubleArray {
        val (r, g, b) = rgb(c).map { it / 255.0 }
        val mx = max(r, max(g, b))
        val mn = min(r, min(g, b))
        val l = (mx + mn) / 2
        if (mx == mn) return doubleArrayOf(0.0, 0.0, l)
        val d = mx - mn
        val s = d / (1 - abs(2 * l - 1))
        val h = when (mx) {
            r -> ((g - b) / d + 6) % 6
            g -> (b - r) / d + 2
            else -> (r - g) / d + 4
        }
        return doubleArrayOf(h * 60, s, l)
    }

    private fun hslToInt(h: Double, s: Double, l: Double): Int {
        val c = (1 - abs(2 * l - 1)) * s
        val x = c * (1 - abs((h / 60) % 2 - 1))
        val (r, g, b) = when {
            h < 60 -> Triple(c, x, 0.0)
            h < 120 -> Triple(x, c, 0.0)
            h < 180 -> Triple(0.0, c, x)
            h < 240 -> Triple(0.0, x, c)
            h < 300 -> Triple(x, 0.0, c)
            else -> Triple(c, 0.0, x)
        }
        val m = l - c / 2
        return packRgb(rd((r + m) * 255), rd((g + m) * 255), rd((b + m) * 255))
    }

    private val frogGreen: Int
    private val frogDark: Int
    private val frogWhite = hex("#ebebeb")

    init {
        val (h, s, l) = hexToHsl(ACCENT).toList()
        frogGreen = hslToInt(h, s, l)
        frogDark = hslToInt(h, s, max(.1, l * .35))
    }

    private class Pose(val lid: Double = 0.0, val lookX: Double = 0.0, val lookY: Double = 6.0, val scaleY: Double = 1.0, val cursor: Boolean = true)

    private fun frogPixel(px: Double, py: Double, pose: Pose): Int {
        // Rotation, lift and horizontal scale are always neutral in the widgets.
        val oy = 830.0
        val x = px
        val y = oy + (py - oy) / pose.scaleY
        fun seg(ax: Double, ay: Double, bx: Double, by: Double): Double {
            val sx = bx - ax
            val sy = by - ay
            val t = max(0.0, min(1.0, ((x - ax) * sx + (y - ay) * sy) / (sx * sx + sy * sy)))
            return hypot(x - (ax + t * sx), y - (ay + t * sy))
        }
        for (cx in doubleArrayOf(340.0, 684.0)) {
            if (pose.lid > 0 && hypot(x - cx, y - 393) <= 89 && y <= 304 + 178 * pose.lid) return frogGreen
            if (hypot(x - (cx + 14 + pose.lookX), y - 378 - pose.lookY) <= 16) return frogWhite
            if (hypot(x - (cx + pose.lookX), y - 393 - pose.lookY) <= 45) return frogDark
            if (hypot(x - cx, y - 393) <= 85) return frogWhite
        }
        var onStroke = seg(396.0, 575.0, 472.0, 632.0) <= 24 || seg(472.0, 632.0, 396.0, 689.0) <= 24
        if (pose.cursor && seg(526.0, 689.0, 636.0, 689.0) <= 24) onStroke = true
        if (onStroke) return frogDark
        val body = hypot(x - 340, y - 400) <= 135 || hypot(x - 684, y - 400) <= 135 ||
            Math.pow((x - 512) / 360, 2.0) + Math.pow((y - 610) / 220, 2.0) <= 1
        return if (body) frogGreen else 0
    }

    // One sprite per pose: the scene is low-res, so 1 sprite pixel = 1 scene pixel.
    private val sprites = HashMap<String, Bitmap>()

    private fun frogSprite(p: Pose): Bitmap = sprites.getOrPut("${p.lid}|${p.lookX}|${p.lookY}|${p.scaleY}|${p.cursor}") {
        val bmp = Bitmap.createBitmap(COLS, ROWS, Bitmap.Config.ARGB_8888)
        for (r in 0 until ROWS) {
            val y = 205 + (r + .5) * 650 / ROWS
            for (q in 0 until COLS) {
                val c = frogPixel(130 + (q + .5) * 764 / COLS, y, p)
                if (c != 0) bmp.setPixel(q, r, c)
            }
        }
        bmp
    }

    // Pose + hop for time t. Period is 2 s so the 24 frames loop cleanly.
    private fun framePose(t: Double, mood: String): Pair<Pose, Int> {
        val blink = (t % 2) < .2
        val lid = if (blink) 1.0 else 0.0
        return when (mood) {
            "sleep" -> Pose(lid = 1.0, cursor = false, scaleY = rd((1 + .03 * sin(t * Math.PI)) * 100) / 100.0) to 0
            "happy" -> {
                val ph = t % 2
                val hop = if (ph > 1 && ph < 1.5) -rd(sin((ph - 1) * 2 * Math.PI) * 3) else 0
                Pose(lid = lid, lookX = rd(sin(t * Math.PI) * 2) * 6.0) to hop
            }
            else -> Pose(lid = lid, lookX = if ((t % 2) < 1) 12.0 else -4.0, lookY = 4.0) to 0
        }
    }

    private class Box(val x: Int, val y: Int, val w: Int, val h: Int)

    private fun drawFrog(g: Pix, t: Double, mood: String, cx: Double, footY: Double, sc: Double): Box {
        val (pose, hop) = framePose(t, mood)
        val w = rd(COLS * sc)
        val h = rd(ROWS * sc)
        val x = rd(cx - w / 2.0)
        val y = rd(footY - h + hop)
        g.sprite(frogSprite(pose), x, y, w, h)
        return Box(x, y, w, h)
    }

    // ---- shared low-res painting ----
    private val BAYER = arrayOf(intArrayOf(0, 8, 2, 10), intArrayOf(12, 4, 14, 6), intArrayOf(3, 11, 1, 9), intArrayOf(15, 7, 13, 5))
    private val grads = HashMap<String, Bitmap>()

    // Banded gradient with ordered dithering: the "printed" look of pixel art.
    private fun grad(w: Int, h: Int, top: Int, bot: Int, steps: Int = 7): Bitmap = grads.getOrPut("$w|$h|$top|$bot|$steps") {
        if (grads.size > 48) grads.clear()
        val cols = IntArray(steps) { mix(top, bot, it.toDouble() / (steps - 1)) }
        val px = IntArray(w * h)
        for (y in 0 until h) {
            val f = (y.toDouble() / max(1, h - 1)) * (steps - 1)
            val b = min(steps - 2, floor(f).toInt())
            val fr = f - b
            for (x in 0 until w) px[y * w + x] = if (BAYER[y % 4][x % 4] / 16.0 < fr) cols[b + 1] else cols[b]
        }
        Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
    }

    private fun skyAndSun(g: Pix, w: Int, h: Int, t: Double, pal: Pal, skyH: Int = h) {
        g.image(grad(w, skyH, pal.top, pal.bot), 0, 0)
        if (pal.stars > 0) for (i in 0 until 18) {
            g.alpha = pal.stars * (.35 + .65 * abs(sin(t * Math.PI + i * 1.7)))
            g.p(rnd(i) * w, rnd(i + 40) * skyH * .6, 1, 1, hex("#fff8e6"))
        }
        g.alpha = 1.0
        val cx = pal.sunX * w
        val cy = pal.sunY * skyH
        g.alpha = .18; g.disc(cx, cy, 7, pal.sun); g.alpha = 1.0
        g.disc(cx, cy, 4, pal.sun)
        if (pal.moon) g.disc(cx + 2, cy - 1, 3, mix(pal.top, pal.bot, cy / skyH))
    }

    private fun clouds(g: Pix, w: Int, h: Int, t: Double, pal: Pal, n: Int) {
        for (k in 0 until n) {
            val span = w + 26.0
            val x = ((rnd(k + 9) * w + t * 2.5 * (k + 1)) % span + span) % span - 13
            val y = h * (.14 + .13 * k)
            g.alpha = if (pal.moon) .55 else .9
            g.p(x, y, 12, 2, pal.cloud); g.p(x + 3, y - 2, 6, 2, pal.cloud); g.p(x + 8, y - 1, 3, 1, pal.cloud)
            g.alpha = .35; g.p(x + 1, y + 2, 10, 1, mix(pal.cloud, pal.top, .5))
        }
        g.alpha = 1.0
    }

    private fun hills(g: Pix, w: Int, h: Int, base: Double, amp: Double, col: Int, seed: Double) {
        for (x in 0 until w) {
            val y = rd(base + sin(x * .13 + seed) * amp + sin(x * .047 + seed * 2) * amp * .7)
            if (h > y) g.p(x, y, 1, h - y, col)
        }
    }

    private fun tint(g: Pix, w: Int, h: Int, pal: Pal) {
        pal.tint?.let { g.multiply(w, h, it) }
    }

    private fun fireflies(g: Pix, w: Int, h: Int, t: Double, pal: Pal, n: Int, y0: Double, y1: Double) {
        if (pal.stars <= 0) return
        for (i in 0 until n) {
            val x = w * (.08 + .84 * rnd(i + 3)) + sin(t * Math.PI + i) * 3
            val y = h * (y0 + (y1 - y0) * rnd(i + 21)) + cos(t * Math.PI + i * 2) * 2
            val a = pal.stars * (.4 + .6 * abs(sin(t * Math.PI * .5 + i)))
            g.alpha = a * .3; g.p(x - 1, y - 1, 3, 3, hex("#f8f0a0"))
            g.alpha = a; g.p(x, y, 1, 1, hex("#fffbd0"))
        }
        g.alpha = 1.0
    }

    private val ZZZ = arrayOf("1111", "..1.", ".1..", "1111")

    private fun zzz(g: Pix, x: Number, y: Number, t: Double) {
        for (k in 0..1) {
            val ph = (t / 2 + k * .5) % 1
            val ox = x.toDouble() + k * 4
            val oy = y.toDouble() - ph * 8
            g.alpha = 1 - ph
            ZZZ.forEachIndexed { r, row -> row.forEachIndexed { c, ch -> if (ch == '1') g.p(ox + c, oy + r, 1, 1, hex("#eef4ff")) } }
        }
        g.alpha = 1.0
    }

    // ---- A · Finestra ----
    private fun sceneA(g: Pix, w: Int, h: Int, t: Double, pal: Pal, s: SceneData, fs: Double) {
        skyAndSun(g, w, h, t, pal, rd(h * .8))
        if (!pal.moon) clouds(g, w, h, t, pal, 2)
        hills(g, w, h, h * .62, 2.2, pal.far, 1.0)
        hills(g, w, h, h * .8, 1.2, pal.near, 4.0)
        g.p(0, h - 3, w, 3, pal.ground)
        val tuft = mix(pal.near, hex("#ffffff"), .12)
        for (i in 0 until 9) {
            val x = rnd(i + 70) * w
            val sw = rd(sin(t * Math.PI + i) * .8)
            g.p(x, h * .8 - 2, 1, 2, tuft); g.p(x + sw, h * .8 - 3, 1, 1, tuft)
        }
        // rock + frog
        val rx = w * .32
        val ry = rd(h * .88)
        g.oval(rx, ry, 9, 2, mix(pal.ground, hex("#8a8f88"), .35))
        g.p(rx - 6, ry - 2, 10, 1, mix(pal.ground, hex("#c9ccc4"), .45))
        val f = drawFrog(g, t, s.mood, rx, ry - 1.0, fs)
        tint(g, w, h, pal)
        fireflies(g, w, h, t, pal, 5, .4, .78)
        if (s.mood == "sleep") zzz(g, f.x + f.w - 2, f.y + 2, t)
    }

    // ---- B · Canneto ----
    fun reedX(w: Int, i: Int): Int = rd(w * .5 + i * (w * .45 / 6))

    private fun sceneB(g: Pix, w: Int, h: Int, t: Double, pal: Pal, s: SceneData, fs: Double) {
        val wy = h - 12
        skyAndSun(g, w, h, t, pal, wy)
        if (!pal.moon) clouds(g, w, h, t, pal, 3)
        hills(g, w, wy + 1, h * .56, 2.5, pal.far, 2.0)
        hills(g, w, wy + 1, h * .74, 1.4, mix(pal.near, pal.far, .3), 5.0)
        // water with reflections
        g.image(grad(w, h - wy, pal.water, pal.water2, 4), 0, wy)
        for (i in 0 until 9) {
            val x = (rnd(i + 90) * w + t * 3 * (1 + (i % 3))) % w
            val y = wy + 2 + (i % 4) * 2
            g.alpha = .35; g.p(x, y, 3 + (i % 3), 1, hex("#ffffff"))
        }
        g.alpha = 1.0
        val mx = max(s.week.max(), 1)
        val tallest = s.week.indexOf(s.week.max())
        val maxH = h * .52
        s.week.forEachIndexed { i, n ->
            val x = reedX(w, i)
            val today = i == 6
            val hh = if (n > 0) rd(5 + (n.toDouble() / mx) * maxH) else 2
            val top = wy - hh
            val col = if (today) ACCENT else pal.reed
            val sway = rd(sin(t * Math.PI + i * .9) * 1)
            // reflection
            g.alpha = .28
            var y = 0
            while (y < min(10, hh)) { g.p(x + (if (y % 4 != 0) 1 else 0), wy + 1 + y, 1, 1, col); y += 2 }
            g.alpha = 1.0
            // stem (the upper part sways)
            val cut = rd(hh * .4)
            g.p(x, top + cut, 1, hh - cut + 1, col)
            g.p(x + sway, top, 1, cut + 1, col)
            // leaves
            if (hh > 6) { g.p(x - 1, wy - 3, 1, 2, col); g.p(x - 2, wy - 5, 1, 2, col); g.p(x + 1, wy - 6, 1, 3, col); g.p(x + 2, wy - 8, 1, 2, col) }
            if (i == tallest && n > 0) return@forEachIndexed
            if (n == 0) return@forEachIndexed
            if (today) { // today blooms
                val fx = x + sway
                val fy = top - 1
                val petal = hex("#f2a9bd")
                g.p(fx - 1, fy, 3, 1, petal); g.p(fx, fy - 1, 1, 3, petal); g.p(fx - 2, fy - 2, 1, 1, petal); g.p(fx + 2, fy - 2, 1, 1, petal); g.p(fx, fy, 1, 1, hex("#ffe08a"))
            } else { // cattail
                g.p(x + sway - 1, top - 1, 3, 5, hex("#7a5233")); g.p(x + sway, top - 3, 1, 2, col); g.p(x + sway - 1, top, 1, 3, hex("#94683f"))
            }
        }
        // frog on the tallest reed, on a leaf
        var f: Box? = null
        if (s.week[tallest] > 0) {
            val x = reedX(w, tallest)
            val top = wy - rd(5 + maxH)
            g.p(x - 5, top + 1, 11, 1, mix(pal.reed, hex("#000000"), .2))
            g.p(x - 4, top, 9, 1, if (tallest == 6) ACCENT else mix(pal.reed, hex("#ffffff"), .12))
            f = drawFrog(g, t, s.mood, x.toDouble(), top + 1.0, fs)
        }
        // dragonfly
        val dx = w * .3 + sin(t * Math.PI) * w * .1
        val dy = h * .3 + sin(t * Math.PI * 2) * 4
        val flap = floor(t * 8).toInt() % 2
        g.p(dx, dy, 5, 1, hex("#3aa3b5")); g.p(dx + 5, dy, 1, 1, hex("#1d5560"))
        g.alpha = .7
        g.p(dx + 1, dy - (if (flap != 0) 2 else 1), 2, 1, hex("#e8f6ff")); g.p(dx + 3, dy - (if (flap != 0) 1 else 2), 2, 1, hex("#e8f6ff"))
        g.alpha = 1.0
        tint(g, w, h, pal)
        fireflies(g, w, h, t, pal, 6, .45, .8)
        if (f != null && s.mood == "sleep") zzz(g, f.x + f.w, f.y, t)
    }

    // ---- C · Stagno ----
    private val PADS = arrayOf(
        doubleArrayOf(.12, .9), doubleArrayOf(.56, .84), doubleArrayOf(.66, .58), doubleArrayOf(.86, .72), doubleArrayOf(.47, .5),
        doubleArrayOf(.8, .4), doubleArrayOf(.95, .54), doubleArrayOf(.6, .32), doubleArrayOf(.2, .62),
    )

    private fun sceneC(g: Pix, w: Int, h: Int, t: Double, pal: Pal, s: SceneData, fs: Double) {
        val shore = 8
        // far shore on top, then water reflecting the sky
        g.image(grad(w, shore + 1, pal.top, pal.bot, 4), 0, 0)
        if (pal.stars > 0) for (i in 0 until 8) { g.alpha = pal.stars * (.4 + .6 * abs(sin(t * Math.PI + i))); g.p(rnd(i + 5) * w, rnd(i + 8) * 4, 1, 1, hex("#fff8e6")) }
        g.alpha = 1.0
        hills(g, w, shore + 2, 4.0, 1.4, pal.far, 3.0)
        g.image(grad(w, h - shore, mix(pal.bot, pal.water, .55), pal.water2, 6), 0, shore)
        g.p(0, shore, w, 1, mix(pal.far, hex("#000000"), .25))
        // broken sun/moon reflection
        val rx = pal.sunX * w
        var y = shore + 3
        while (y < h - 4) {
            val ww = max(1, rd(3 + sin(t * Math.PI * 2 + y) * 2 - (y - shore) * .05))
            g.alpha = .45; g.p(rx - ww / 2.0 + sin(t * Math.PI + y) * 1, y, ww, 1, pal.sun)
            y += 3
        }
        g.alpha = 1.0
        // a fish passing underneath
        val fx = ((t * 9) % (w + 24)) - 12
        g.alpha = .22; g.oval(fx, h * .66, 5, 1, hex("#000000")); g.p(fx - 7, h * .66 - 1, 2, 3, hex("#000000")); g.alpha = 1.0
        // lily pads: one in bloom for each session today
        val padCol = mix(pal.reed, hex("#88b060"), .35)
        val padDark = mix(pal.reed, hex("#000000"), .25)
        PADS.forEachIndexed { i, (px, py) ->
            val x = px * w
            val yy = py * h + rd(sin(t * Math.PI + i) * .6)
            g.oval(x, yy, 4, 1, padCol); g.p(x, yy - 1, 3, 1, mix(pal.water, pal.water2, .5)); g.p(x - 3, yy + 1, 7, 1, padDark)
            if (i < s.today) {
                val pc = hex("#f4aac0")
                if (pal.stars > .5) { g.alpha = .25; g.p(x - 2, yy - 4, 5, 4, hex("#ffd6e2")); g.alpha = 1.0 }
                g.p(x - 1, yy - 2, 3, 1, pc); g.p(x, yy - 3, 1, 1, pc); g.p(x - 2, yy - 3, 1, 1, pc); g.p(x + 2, yy - 3, 1, 1, pc); g.p(x, yy - 2, 1, 1, hex("#ffe08a"))
            }
        }
        // ripples around the frog
        val cx = w * .25
        val cy = rd(h * .8).toDouble()
        for (k in 0..1) {
            val r = 12 + ((t * 5 + k * 6) % 12)
            g.alpha = .3 * (1 - (r - 12) / 12)
            g.ellipseStroke(cx, cy, r, r * .25, hex("#ffffff"))
        }
        g.alpha = 1.0
        g.oval(cx, cy, 9, 2, padCol); g.p(cx + 3, cy - 2, 5, 1, mix(pal.water, pal.water2, .5)); g.p(cx - 7, cy + 2, 14, 1, padDark)
        val f = drawFrog(g, t, s.mood, cx, cy, fs)
        // flies + tongue (only when awake)
        val flies = listOf(doubleArrayOf(.46, .3), doubleArrayOf(.52, .42), doubleArrayOf(.4, .2)).mapIndexed { i, (a, b) ->
            doubleArrayOf(w * a + sin(t * Math.PI * 2 + i * 2) * 3, h * b + cos(t * Math.PI * 2 + i) * 2)
        }
        val catching = s.mood != "sleep" && (t % 2) >= 1.25 && (t % 2) < 1.5
        flies.forEachIndexed { i, (x, yy) ->
            if (catching && i == 0) return@forEachIndexed
            g.p(x, yy, 1, 1, hex("#141110"))
            g.alpha = .6; g.p(x - 1, yy - 1, 1, 1, hex("#ffffff")); g.p(x + 1, yy - 1, 1, 1, hex("#ffffff")); g.alpha = 1.0
        }
        if (catching) {
            val mx = f.x + rd(f.w * .62)
            val my = f.y + rd(f.h * .78)
            val (tx, ty) = flies[0]
            g.line(mx + .5, my + .5, tx + .5, ty + .5, hex("#e88aa0"))
            g.p(tx - 1, ty - 1, 2, 2, hex("#e88aa0"))
        }
        // foreground reeds on the left
        listOf(2 to 22, 5 to 30, 8 to 18).forEachIndexed { i, (x, hh) ->
            val sway = rd(sin(t * Math.PI + i) * 1)
            val c = mix(pal.reed, hex("#000000"), .35)
            g.p(x, h - hh * .55, 1, hh * .55, c); g.p(x + sway, h - hh, 1, hh * .45 + 1, c); g.p(x + sway - 1, h - hh - 1, 2, 4, hex("#5a3c26"))
        }
        tint(g, w, h, pal)
        fireflies(g, w, h, t, pal, 6, .25, .7)
        if (s.mood == "sleep") zzz(g, f.x + f.w - 3, f.y + 1, t)
    }

    // ---- entry point ----
    /** kind: 0 = A, 1 = B, 2 = C. Returns the low-res scene; the caller scales it up. */
    @Synchronized
    fun render(kind: Int, w: Int, h: Int, t: Double, hour: Int, s: SceneData): Bitmap {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val g = Pix(bmp)
        val pal = slotFor(hour)
        val m = min(w, h).toDouble()
        // The frog grows and shrinks with the widget, within sane limits.
        fun frogScale(base: Double, refH: Double) = base * max(.7, min(1.8, m / refH))
        when (kind) {
            0 -> sceneA(g, w, h, t, pal, s, frogScale(.62, 37.0))
            1 -> sceneB(g, w, h, t, pal, s, frogScale(.55, 55.0))
            else -> sceneC(g, w, h, t, pal, s, frogScale(.6, 37.0))
        }
        return bmp
    }
}
