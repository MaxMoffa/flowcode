package com.maxmoffa.flowcode.mobile

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException

/**
 * Hands the launcher the widget animation frames. Bitmaps cannot go through
 * RemoteViews (1 MB binder limit), so the frames are PNG files and the widget
 * points at them by URI. Exported because the launcher process reads it, which
 * is why it serves nothing but .png files inside filesDir/widgets, read-only.
 */
class WidgetFrameProvider : ContentProvider() {
    override fun onCreate() = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("read-only")
        val ctx = context ?: throw FileNotFoundException()
        val segments = uri.pathSegments
        if (segments.isEmpty() || segments.any { it == ".." || it == "." || it.isEmpty() }) throw FileNotFoundException()
        val root = File(ctx.filesDir, "widgets").canonicalFile
        val file = File(root, segments.joinToString(File.separator)).canonicalFile
        if (!file.path.startsWith(root.path + File.separator) || !file.name.endsWith(".png") || !file.isFile) throw FileNotFoundException()
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri) = "image/png"
    override fun query(uri: Uri, projection: Array<String>?, selection: String?, selectionArgs: Array<String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?) = 0
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?) = 0
}
