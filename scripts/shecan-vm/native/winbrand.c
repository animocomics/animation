/*
 * Compatibility implementation of Wine's winbrand semi-stub.
 * Based on wine-mirror/wine dlls/winbrand/main.c (Copyright 2025
 * Esme Povirk for CodeWeavers), licensed under LGPL-2.1-or-later.
 * It expands the same WINDOWS_SHORT and WINDOWS_LONG variables without
 * changing or wrapping the Shecan application.
 */
#include <windows.h>

static const WCHAR short_token[] = L"%WINDOWS_SHORT%";
static const WCHAR long_token[] = L"%WINDOWS_LONG%";
static const WCHAR short_value[] = L"Windows 10";
static const WCHAR long_value[] = L"Windows 10 Pro";

static SIZE_T length_of(const WCHAR *s)
{
    SIZE_T n = 0;
    while (s[n]) n++;
    return n;
}

static BOOL starts_with(const WCHAR *s, const WCHAR *token)
{
    SIZE_T i = 0;
    while (token[i]) {
        if (s[i] != token[i]) return FALSE;
        i++;
    }
    return TRUE;
}

LPWSTR WINAPI BrandingFormatString(LPWSTR format)
{
    const SIZE_T short_token_len = length_of(short_token);
    const SIZE_T long_token_len = length_of(long_token);
    const SIZE_T short_value_len = length_of(short_value);
    const SIZE_T long_value_len = length_of(long_value);
    const WCHAR *src;
    WCHAR *dst, *result;
    SIZE_T needed = 0;

    if (!format) return NULL;
    for (src = format; *src;) {
        if (starts_with(src, long_token)) {
            needed += long_value_len;
            src += long_token_len;
        } else if (starts_with(src, short_token)) {
            needed += short_value_len;
            src += short_token_len;
        } else {
            needed++;
            src++;
        }
    }

    result = HeapAlloc(GetProcessHeap(), 0, (needed + 1) * sizeof(WCHAR));
    if (!result) return NULL;
    src = format;
    dst = result;
    while (*src) {
        const WCHAR *replacement = NULL;
        SIZE_T token_len = 0, replacement_len = 0, i;
        if (starts_with(src, long_token)) {
            replacement = long_value;
            token_len = long_token_len;
            replacement_len = long_value_len;
        } else if (starts_with(src, short_token)) {
            replacement = short_value;
            token_len = short_token_len;
            replacement_len = short_value_len;
        }
        if (replacement) {
            for (i = 0; i < replacement_len; i++) *dst++ = replacement[i];
            src += token_len;
        } else {
            *dst++ = *src++;
        }
    }
    *dst = 0;
    return result;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved)
{
    (void)instance;
    (void)reason;
    (void)reserved;
    return TRUE;
}
