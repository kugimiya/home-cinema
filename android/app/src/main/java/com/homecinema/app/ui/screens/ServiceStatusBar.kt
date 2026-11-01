package com.homecinema.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.homecinema.app.data.api.HomeCinemaApi
import com.homecinema.app.data.api.ServiceStatus
import com.homecinema.app.ui.theme.HomeBorder
import com.homecinema.app.ui.theme.HomeError
import com.homecinema.app.ui.theme.HomeMuted
import kotlinx.coroutines.delay

private fun dotColor(state: String): Color = when (state) {
    "ok" -> Color(0xFF22C55E)
    "busy" -> Color(0xFFEAB308)
    "degraded" -> Color(0xFFF97316)
    "down" -> Color(0xFFEF4444)
    else -> Color(0xFF6B7280)
}

@Composable
fun ServiceStatusBar(
    api: HomeCinemaApi,
    apiBaseUrl: String,
    pollMs: Long = 10_000,
) {
    var services by remember { mutableStateOf<List<ServiceStatus>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(apiBaseUrl) {
        while (true) {
            try {
                services = api.systemStatus().services
                error = null
            } catch (e: Exception) {
                error = e.message
            }
            delay(pollMs)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, HomeBorder, MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.medium)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        error?.let { Text(it, color = HomeError, style = MaterialTheme.typography.bodySmall) }
        services.forEach { svc ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                androidx.compose.foundation.layout.Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(dotColor(svc.state)),
                )
                Text(svc.label, style = MaterialTheme.typography.labelLarge)
                Text(
                    svc.activity,
                    color = HomeMuted,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
            }
        }
    }
}
