package com.homecinema.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.unit.dp
import com.homecinema.app.ui.theme.HomeBorder
import com.homecinema.app.ui.theme.HomeTextPrimary
import com.homecinema.app.ui.theme.homePrimaryButtonColors
import com.homecinema.app.ui.theme.homeSecondaryButtonColors

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = homePrimaryButtonColors(),
        modifier = modifier.defaultMinSize(minHeight = 44.dp),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(text, color = HomeTextPrimary)
    }
}

@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.defaultMinSize(minHeight = 44.dp),
        border = BorderStroke(1.dp, HomeBorder),
        colors = homeSecondaryButtonColors(),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(text, color = HomeTextPrimary)
    }
}

@Composable
fun TabChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = if (selected) {
        homePrimaryButtonColors()
    } else {
        homeSecondaryButtonColors()
    }
    OutlinedButton(
        onClick = onClick,
        modifier = modifier
            .defaultMinSize(minHeight = 44.dp)
            .onFocusChanged { },
        border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else HomeBorder),
        colors = colors,
    ) {
        Text(
            label,
            color = HomeTextPrimary,
            fontWeight = if (selected) androidx.compose.ui.text.font.FontWeight.SemiBold else null,
        )
    }
}
