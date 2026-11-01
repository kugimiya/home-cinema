package com.homecinema.app.ui.theme

import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle

private val Bg = Color(0xFF0F1115)
private val SurfaceColor = Color(0xFF141820)
private val Border = Color(0xFF2A2F3A)
private val TextPrimary = Color(0xFFFFFFFF)
private val TextMuted = Color(0xFF9CA3AF)
private val Link = Color(0xFF8AB4F8)
private val Error = Color(0xFFFCA5A5)
/** Dark navy, slightly lighter than [Bg] — default interactive surfaces. */
private val ButtonBg = Color(0xFF1A2438)
/** Focus / hover on TV and pointer devices. */
private val ButtonBgFocused = Color(0xFF243552)

val HomeBorder = Border
val HomeMuted = TextMuted
val HomeLink = Link
val HomeError = Error
val HomeTextPrimary = TextPrimary

private val scheme = darkColorScheme(
    primary = Link,
    onPrimary = TextPrimary,
    secondary = ButtonBg,
    onSecondary = TextPrimary,
    background = Bg,
    onBackground = TextPrimary,
    surface = SurfaceColor,
    onSurface = TextPrimary,
    surfaceVariant = ButtonBg,
    onSurfaceVariant = TextPrimary,
    error = Error,
    onError = TextPrimary,
    outline = Border,
)

private fun Typography.withTextColor(color: Color): Typography {
    fun TextStyle.tinted() = copy(color = color)
    return copy(
        displayLarge = displayLarge.tinted(),
        displayMedium = displayMedium.tinted(),
        displaySmall = displaySmall.tinted(),
        headlineLarge = headlineLarge.tinted(),
        headlineMedium = headlineMedium.tinted(),
        headlineSmall = headlineSmall.tinted(),
        titleLarge = titleLarge.tinted(),
        titleMedium = titleMedium.tinted(),
        titleSmall = titleSmall.tinted(),
        bodyLarge = bodyLarge.tinted(),
        bodyMedium = bodyMedium.tinted(),
        bodySmall = bodySmall.tinted(),
        labelLarge = labelLarge.tinted(),
        labelMedium = labelMedium.tinted(),
        labelSmall = labelSmall.tinted(),
    )
}

@Composable
fun homePrimaryButtonColors(): ButtonColors = ButtonDefaults.buttonColors(
    containerColor = ButtonBg,
    contentColor = TextPrimary,
    disabledContainerColor = ButtonBg.copy(alpha = 0.45f),
    disabledContentColor = TextPrimary.copy(alpha = 0.45f),
)

@Composable
fun homeSecondaryButtonColors(): ButtonColors = ButtonDefaults.outlinedButtonColors(
    contentColor = TextPrimary,
    disabledContentColor = TextPrimary.copy(alpha = 0.45f),
)

@Composable
fun homeTextFieldColors(): TextFieldColors = OutlinedTextFieldDefaults.colors(
    focusedTextColor = TextPrimary,
    unfocusedTextColor = TextPrimary,
    disabledTextColor = TextMuted,
    focusedContainerColor = SurfaceColor,
    unfocusedContainerColor = SurfaceColor,
    disabledContainerColor = SurfaceColor.copy(alpha = 0.6f),
    cursorColor = Link,
    focusedBorderColor = Border,
    unfocusedBorderColor = Border,
    disabledBorderColor = Border.copy(alpha = 0.5f),
    focusedLabelColor = TextMuted,
    unfocusedLabelColor = TextMuted,
    disabledLabelColor = TextMuted,
    focusedPlaceholderColor = TextMuted,
    unfocusedPlaceholderColor = TextMuted,
)

@Composable
fun HomeCinemaTheme(content: @Composable () -> Unit) {
    val typography = MaterialTheme.typography.withTextColor(TextPrimary)
    MaterialTheme(
        colorScheme = scheme,
        typography = typography,
        content = {
            CompositionLocalProvider(
                androidx.compose.material3.LocalContentColor provides TextPrimary,
                content = content,
            )
        },
    )
}
