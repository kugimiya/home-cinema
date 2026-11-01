package com.homecinema.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.homecinema.app.ui.theme.HomeLink
import com.homecinema.app.ui.theme.HomeMuted

@Composable
fun HomeLoadingIndicator(
    modifier: Modifier = Modifier,
    message: String? = null,
) {
    Column(
        modifier = modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(
            color = HomeLink,
            strokeWidth = 3.dp,
            modifier = Modifier.size(48.dp),
        )
        if (!message.isNullOrBlank()) {
            Text(
                message,
                color = HomeMuted,
                modifier = Modifier.padding(top = 16.dp),
            )
        }
    }
}

@Composable
fun LoadingOverlay(
    visible: Boolean,
    message: String? = null,
    modifier: Modifier = Modifier,
) {
    if (!visible) return
    Box(
        modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.55f)),
        contentAlignment = Alignment.Center,
    ) {
        HomeLoadingIndicator(message = message)
    }
}
