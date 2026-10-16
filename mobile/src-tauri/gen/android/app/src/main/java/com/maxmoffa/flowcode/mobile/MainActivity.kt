package com.maxmoffa.flowcode.mobile

import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  // System bar insets as "top,bottom" in CSS px. Android's WebView doesn't
  // reliably report env(safe-area-inset-*) edge-to-edge, so the page reads
  // them from here (App.tsx, useSystemInsets).
  @Volatile private var insets = ""
  private val prefs by lazy { getSharedPreferences("flowcode", MODE_PRIVATE) }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applySecure()
    updateImmersiveRequest()
  }

  // The screen shows live terminals: keep it out of screenshots, screen
  // recording and the Recents thumbnail, unless the user allowed them in
  // Settings > Security (screenshots.ts).
  private fun applySecure() {
    if (prefs.getBoolean(KEY_SCREENSHOTS, false)) window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    else window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
  }

  override fun onMultiWindowModeChanged(isInMultiWindowMode: Boolean, newConfig: Configuration) {
    super.onMultiWindowModeChanged(isInMultiWindowMode, newConfig)
    updateImmersiveRequest()
  }

  // Android's desktop windowing offers full screen ("Immersive") in a window's
  // header menu only to apps that ask to hide the system bars. A desktop window
  // keeps the bars anyway, so ask only there: the phone keeps its status bar.
  private fun updateImmersiveRequest() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return
    val bars = WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.navigationBars()
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    val display = windowManager.maximumWindowMetrics.bounds
    val density = resources.displayMetrics.density
    val largeScreen = minOf(display.width(), display.height()) / density >= 600
    if (isInMultiWindowMode && largeScreen) {
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(bars)
    } else {
      controller.show(bars)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(InsetsBridge(), "FlowcodeInsets")
    webView.addJavascriptInterface(ScreenshotsBridge(), "FlowcodeScreenshots")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, all ->
      val bars = all.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val density = view.resources.displayMetrics.density
      // With the keyboard up the navigation bar sits behind it: no bottom gap.
      val bottom = if (all.isVisible(WindowInsetsCompat.Type.ime())) 0 else bars.bottom
      val next = "${bars.top / density},${bottom / density}"
      if (next != insets) {
        insets = next
        view.post { webView.evaluateJavascript("window.dispatchEvent(new Event('flowcode-insets'))", null) }
      }
      ViewCompat.onApplyWindowInsets(view, all)
    }
  }

  inner class InsetsBridge {
    @JavascriptInterface
    fun get(): String = insets
  }

  inner class ScreenshotsBridge {
    @JavascriptInterface
    fun allowed(): Boolean = prefs.getBoolean(KEY_SCREENSHOTS, false)

    @JavascriptInterface
    fun setAllowed(on: Boolean) {
      prefs.edit().putBoolean(KEY_SCREENSHOTS, on).apply()
      runOnUiThread { applySecure() }
    }
  }

  private companion object {
    const val KEY_SCREENSHOTS = "screenshotsAllowed"
  }
}
