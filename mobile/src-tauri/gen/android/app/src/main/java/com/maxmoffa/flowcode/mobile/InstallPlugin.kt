package com.maxmoffa.flowcode.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

private const val TAG = "InstallPlugin"

/** Must match `UPDATE_DIR` in updater.rs and the path in res/xml/update_file_paths.xml. */
private const val UPDATE_DIR = "updates"

@InvokeArg
class InstallArgs {
    lateinit var path: String
}

/**
 * Hands the APK the Rust updater downloaded and verified to Android's package
 * installer. Without the "install unknown apps" permission for this app it
 * opens that settings screen instead and reports `needsPermission`.
 */
@TauriPlugin
class InstallPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun installApk(invoke: Invoke) {
        val args = invoke.parseArgs(InstallArgs::class.java)
        try {
            // Only ever install what the updater stored in its own folder.
            val dir = File(activity.cacheDir, UPDATE_DIR).canonicalFile
            val apk = File(args.path).canonicalFile
            if (apk.parentFile != dir || !apk.isFile) {
                invoke.reject("Not an update file")
                return
            }
            // Before Android 8 the system-wide "unknown sources" switch applies and the installer asks for it itself.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
                val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                activity.startActivity(settings)
                invoke.resolve(reply("needsPermission"))
                return
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", apk)
            val install = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.startActivity(install)
            invoke.resolve(reply("started"))
        } catch (e: Exception) {
            Log.w(TAG, "could not start the installer: ${e.message}")
            invoke.reject("Install failed: ${e.message}")
        }
    }

    private fun reply(status: String) = JSObject().apply { put("status", status) }
}
