package com.homecinema.app.ui.util

/** Rough duration from file size when ffprobe only saw a partial buffer (~0.5 MB/s). */
fun estimateDurationFromFileBytes(length: Long): Double? {
    if (length <= 0L) return null
    val megabytes = length / (1024.0 * 1024.0)
    return megabytes * 2.0
}

fun resolveFileDurationSec(apiDurationSec: Double?, fileLengthBytes: Long): Double {
    val api = apiDurationSec?.takeIf { it > 0 } ?: 0.0
    val estimate = estimateDurationFromFileBytes(fileLengthBytes) ?: 0.0
    if (api <= 0.0) return estimate
    if (estimate <= 0.0) return api
    if (api < 120.0 && estimate > api * 2.5) return estimate
    if (fileLengthBytes > 100L * 1024 * 1024 && api < 300.0 && estimate > api) return estimate
    return maxOf(api, estimate)
}
