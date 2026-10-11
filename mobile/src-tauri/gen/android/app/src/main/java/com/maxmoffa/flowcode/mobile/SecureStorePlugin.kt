package com.maxmoffa.flowcode.mobile

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val KEY_ALIAS = "flowcode-secrets"
private const val IV_LENGTH = 12
private const val TAG_LENGTH_BITS = 128

@InvokeArg
class SecureData {
    lateinit var data: String
}

/**
 * Encrypts the files the Rust side keeps on disk with a non-exportable
 * Keystore key. No user authentication on the key: the app lock already gates
 * the UI, and requiring it here would break background reconnects.
 */
@TauriPlugin
class SecureStorePlugin(activity: Activity) : Plugin(activity) {

    @Command
    fun seal(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureData::class.java)
            val plain = Base64.decode(args.data, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            // The Keystore picks the IV; keep it in front of the ciphertext.
            val out = cipher.iv + cipher.doFinal(plain)
            invoke.resolve(JSObject().apply { put("data", Base64.encodeToString(out, Base64.NO_WRAP)) })
        } catch (e: Exception) {
            invoke.reject("Seal failed: ${e.message}")
        }
    }

    @Command
    fun open(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureData::class.java)
            val sealed = Base64.decode(args.data, Base64.NO_WRAP)
            if (sealed.size <= IV_LENGTH) throw IllegalArgumentException("too short")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_LENGTH_BITS, sealed, 0, IV_LENGTH))
            val plain = cipher.doFinal(sealed, IV_LENGTH, sealed.size - IV_LENGTH)
            invoke.resolve(JSObject().apply { put("data", Base64.encodeToString(plain, Base64.NO_WRAP)) })
        } catch (e: Exception) {
            invoke.reject("Open failed: ${e.message}")
        }
    }

    @Synchronized
    private fun key(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
            init(spec)
            generateKey()
        }
    }
}
