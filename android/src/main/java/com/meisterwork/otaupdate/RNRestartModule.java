package com.meisterwork.otaupdate;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class RNRestartModule extends ReactContextBaseJavaModule {

    public RNRestartModule(@NonNull ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @NonNull
    @Override
    public String getName() {
        return "RNRestartModule";
    }

    @ReactMethod
    public void restart() {
        final Activity activity = getCurrentActivity();
        if (activity == null) {
            return;
        }

        final PackageManager pm = activity.getPackageManager();
        final Intent intent = pm.getLaunchIntentForPackage(activity.getPackageName());

        if (intent == null) {
            return;
        }

        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        // Use a small delay to ensure clean shutdown
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            activity.finishAffinity();
            activity.startActivity(intent);
            System.exit(0);
        }, 100);
    }
}
