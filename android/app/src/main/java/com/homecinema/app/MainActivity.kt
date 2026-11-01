package com.homecinema.app

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import com.homecinema.app.data.discovery.ServerDiscovery
import com.homecinema.app.ui.layout.appSafeDrawingPadding
import com.homecinema.app.ui.navigation.HomeNav
import com.homecinema.app.ui.player.PlayerKeyDispatcher
import com.homecinema.app.ui.theme.HomeCinemaTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as HomeCinemaApp
        val discovery = ServerDiscovery(this)
        setContent {
            HomeCinemaTheme {
                // Box instead of Material Surface: Surface's offscreen compositing breaks
                // PlayerView/SurfaceView on Android TV (video black, audio ok).
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background)
                        .appSafeDrawingPadding(),
                ) {
                    HomeNav(
                        serverStore = app.serverStore,
                        discovery = discovery,
                    )
                }
            }
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        PlayerKeyDispatcher.handler?.let { handler ->
            if (handler(event)) return true
        }
        return super.dispatchKeyEvent(event)
    }
}
