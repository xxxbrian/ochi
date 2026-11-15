package co.bojin.ochi

import android.content.Intent
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import java.io.File

class ClientInstallerPackage : ReactPackage {
  @Suppress("OVERRIDE_DEPRECATION")
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(ClientInstallerModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class ClientInstallerModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {
  override fun getName() = "OchiClientInstaller"

  @Suppress("DEPRECATION")
  private fun versionCode(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

  @ReactMethod
  @Suppress("DEPRECATION")
  fun getInstalledVersion(promise: Promise) {
    try {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      promise.resolve(Arguments.createMap().apply {
        putString("packageName", context.packageName)
        putString("versionName", info.versionName ?: "")
        putDouble("versionCode", versionCode(info).toDouble())
      })
    } catch (error: Exception) {
      promise.reject("VERSION_UNAVAILABLE", "Unable to read the installed version", error)
    }
  }

  @ReactMethod
  fun canRequestPackageInstalls(promise: Promise) {
    promise.resolve(
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
    )
  }

  @ReactMethod
  fun openInstallPermissionSettings(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startActivity(Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${context.packageName}")
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("PERMISSION_SETTINGS_UNAVAILABLE", "Unable to open installation settings", error)
    }
  }

  @ReactMethod
  @Suppress("DEPRECATION")
  fun inspectApk(path: String, promise: Promise) {
    try {
      val file = File(path).canonicalFile
      val directory = File(context.cacheDir, "client-updates").canonicalFile
      require(file.path.startsWith("${directory.path}${File.separator}") && file.isFile)
      val info = context.packageManager.getPackageArchiveInfo(file.path, 0)
        ?: throw IllegalArgumentException("Invalid package")
      promise.resolve(Arguments.createMap().apply {
        putString("packageName", info.packageName)
        putString("versionName", info.versionName ?: "")
        putDouble("versionCode", versionCode(info).toDouble())
      })
    } catch (error: Exception) {
      promise.reject("INVALID_APK", "Unable to read the downloaded package", error)
    }
  }
}
