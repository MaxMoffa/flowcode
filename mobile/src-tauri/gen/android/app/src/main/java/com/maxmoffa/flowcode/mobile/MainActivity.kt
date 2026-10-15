package com.maxmoffa.flowcode.mobile

import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // System bar insets as "top,bottom" in CSS px. Android's WebView doesn't
  // reliably report env(safe-area-inset-*) edge-to-edge, so the page reads
  // them from here (App.tsx, useSystemInsets).
  @Volatile private var insets = ""

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The screen shows live terminals: keep it out of screenshots, screen
    // recording and the Recents thumbnail.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(InsetsBridge(), "FlowcodeInsets")
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
}
