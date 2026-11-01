package com.homecinema.app.ui.player

import android.view.KeyEvent

/**
 * Forwards Activity [KeyEvent]s to the active [androidx.media3.ui.PlayerView] on Android TV.
 */
object PlayerKeyDispatcher {
    var handler: ((KeyEvent) -> Boolean)? = null
}
