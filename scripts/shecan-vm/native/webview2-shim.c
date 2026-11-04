#include <windows.h>
#include <stdio.h>
#include <string.h>

static HMODULE self_module;
static HMODULE real_module;
static void *custom_options_vtable[11];

static void log_result(const char *operation, HRESULT hr, DWORD error)
{
    HANDLE file = CreateFileA("C:\\webview2-shim.log", GENERIC_WRITE,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    char buffer[256];
    DWORD written;
    int length;
    if (file == INVALID_HANDLE_VALUE) return;
    SetFilePointer(file, 0, NULL, FILE_END);
    length = wsprintfA(buffer, "%s hr=%08lx error=%lu\r\n",
                       operation, (unsigned long)hr, error);
    WriteFile(file, buffer, length, &written, NULL);
    CloseHandle(file);
}

static HMODULE load_real(void)
{
    WCHAR path[MAX_PATH];
    DWORD length, i;
    if (real_module) return real_module;
    length = GetModuleFileNameW(self_module, path, MAX_PATH);
    if (!length || length >= MAX_PATH) return NULL;
    for (i = length; i > 0 && path[i - 1] != L'\\' && path[i - 1] != L'/'; i--) {}
    path[i] = 0;
    if (lstrlenW(path) + 31 >= MAX_PATH) return NULL;
    lstrcatW(path, L"EmbeddedBrowserWebView-real.dll");
    real_module = LoadLibraryW(path);
    return real_module;
}

typedef HRESULT (WINAPI *create_environment_proc)(int, int, LPCWSTR, void *, void *);

static HRESULT WINAPI get_browser_arguments(void *options, LPWSTR *value)
{
    static const WCHAR arguments[] = L"--use-angle=gl --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1";
    SIZE_T bytes = sizeof(arguments);
    LPWSTR copy;
    (void)options;
    if (!value) return E_POINTER;
    copy = (LPWSTR)CoTaskMemAlloc(bytes);
    if (!copy) return E_OUTOFMEMORY;
    memcpy(copy, arguments, bytes);
    *value = copy;
    return S_OK;
}

__declspec(dllexport) HRESULT WINAPI CreateWebViewEnvironmentWithOptionsInternal(
    int unknown, int runtime_type, LPCWSTR user_data_folder,
    void *environment_options, void *completed_handler)
{
    HMODULE real = load_real();
    create_environment_proc create_environment;
    HRESULT result = E_FAIL;
    if (!real) {
        log_result("load-real", result, GetLastError());
        return result;
    }
    create_environment = (create_environment_proc)GetProcAddress(
        real, "CreateWebViewEnvironmentWithOptionsInternal");
    if (!create_environment) {
        log_result("find-create", result, GetLastError());
        return result;
    }
    if (environment_options) {
        void **original_vtable = *(void ***)environment_options;
        memcpy(custom_options_vtable, original_vtable, sizeof(custom_options_vtable));
        custom_options_vtable[3] = (void *)get_browser_arguments;
        *(void ***)environment_options = custom_options_vtable;
        log_result("hook-arguments", S_OK, 0);
    }
    result = create_environment(unknown, runtime_type, user_data_folder,
                                environment_options, completed_handler);
    log_result("create-environment", result, 0);
    return result;
}

__declspec(dllexport) HRESULT WINAPI DllCanUnloadNow(void)
{
    /* The small options vtable above must remain valid until the environment
     * has consumed it, so this compatibility module stays loaded. */
    return S_FALSE;
}

__declspec(dllexport) void *WINAPI GetHandleVerifier(void)
{
    HMODULE real = load_real();
    void *(WINAPI *get_verifier)(void);
    if (!real) return NULL;
    get_verifier = (void *(WINAPI *)(void))GetProcAddress(real, "GetHandleVerifier");
    return get_verifier ? get_verifier() : NULL;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        self_module = (HMODULE)instance;
        DisableThreadLibraryCalls((HMODULE)instance);
    }
    return TRUE;
}
