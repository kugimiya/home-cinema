package com.homecinema.app.ui.util

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import retrofit2.HttpException

private val errorJson = Json { ignoreUnknownKeys = true }

private fun detailFromJson(raw: String): String? {
    return try {
        when (val el = errorJson.parseToJsonElement(raw)) {
            is JsonObject -> {
                val detail = el["detail"] ?: return raw.takeIf { it.isNotBlank() }
                when (detail) {
                    is JsonPrimitive -> detail.content
                    is JsonArray -> detail.joinToString("\n") { item ->
                        item.jsonPrimitive.content
                    }
                    else -> raw
                }
            }
            else -> raw
        }
    } catch (_: Exception) {
        raw.takeIf { it.isNotBlank() }
    }
}

fun userFacingError(throwable: Throwable): String {
    if (throwable is CancellationException) {
        return "Операция отменена"
    }
    val msg = throwable.message.orEmpty()
    if (msg.contains("left the composition", ignoreCase = true)) {
        return "Операция отменена"
    }
    if (throwable is HttpException) {
        val body = throwable.response()?.errorBody()?.use { it.string().orEmpty() }.orEmpty()
        val detail = detailFromJson(body)
        if (!detail.isNullOrBlank()) return detail
        return when (throwable.code()) {
            503 -> "Сервис временно недоступен (503)"
            502 -> "Ошибка связи с сервером (502)"
            404 -> "Не найдено (404)"
            else -> msg.ifBlank { "HTTP ${throwable.code()}" }
        }
    }
    if (msg.isBlank()) return "Неизвестная ошибка"
    return msg
}
