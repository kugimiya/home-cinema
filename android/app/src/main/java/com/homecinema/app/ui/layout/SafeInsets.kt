package com.homecinema.app.ui.layout

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
fun Modifier.appSafeDrawingPadding(): Modifier =
    windowInsetsPadding(WindowInsets.safeDrawing)
