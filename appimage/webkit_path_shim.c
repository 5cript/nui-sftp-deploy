/* webkit_path_shim — LD_PRELOAD intercept that rewrites webkitgtk-6.0's
 * hardcoded path (/usr/lib/x86_64-linux-gnu/webkitgtk-6.0) to the bundled
 * location inside the AppImage ($APPDIR/usr/lib/...).
 *
 * webkitgtk-6.0 removed the WEBKIT_EXEC_PATH env override, so the only way
 * to relocate its sibling files in an AppImage is to intercept the relevant
 * libc calls:
 *   - posix_spawn / execve : GSubprocess uses these to launch helper processes
 *                            (WebKitNetworkProcess, WebKitWebProcess, ...).
 *   - dlopen / dlmopen     : the injected bundle .so is dlopen'd by absolute
 *                            path from libwebkitgtk-6.0.
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <spawn.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char HOST_PFX[] = "/usr/lib/x86_64-linux-gnu/webkitgtk-6.0";

/**
 * @brief Rewrite a host webkitgtk-6.0 helper path into the AppImage-relative path.
 *
 * If @p path begins with HOST_PFX and is either exactly that directory or a child
 * of it (i.e. the next character is '\0' or '/'), the AppImage prefix from
 * @c $APPDIR is prepended into @p buf and a pointer to @p buf is returned.
 * Otherwise the original @p path pointer is returned unchanged.
 *
 * @param path  Candidate executable path. May be NULL (returned as-is).
 * @param buf   Caller-provided scratch buffer for the rewritten path. Must remain
 *              valid for as long as the returned pointer is used.
 * @param bufsz Size of @p buf in bytes.
 *
 * @return Pointer to the rewritten path inside @p buf on a successful remap, or
 *         the original @p path pointer if no rewrite applies, if @c $APPDIR is
 *         unset/empty, or if the formatted result would not fit in @p buf.
 *
 * @note Reading @c path[pfxlen] is in-bounds: a successful @c strncmp of @c pfxlen
 *       bytes against a NUL-free constant guarantees @p path has at least @c pfxlen
 *       bytes followed by either more characters or the terminating NUL.
 * @warning On snprintf truncation the function silently returns the un-rewritten
 *          host path, which will then fail to exec. There is no diagnostic.
 * @warning HOST_PFX is hardcoded to the Debian/Ubuntu multiarch layout. Other
 *          distributions (Arch, Fedora) install webkitgtk under different prefixes
 *          and will not match.
 */
static const char *remap(const char *path, char *buf, size_t bufsz)
{
    if (!path) return path;
    const size_t pfxlen = sizeof(HOST_PFX) - 1;
    if (strncmp(path, HOST_PFX, pfxlen) != 0) return path;
    /* Match only on the directory or its children (avoid e.g. -extra suffix) */
    const char next = path[pfxlen];
    if (next != '\0' && next != '/') return path;
    const char *appdir = getenv("APPDIR");
    if (!appdir || !*appdir) return path;
    int n = snprintf(buf, bufsz, "%s%s", appdir, path);
    if (n < 0 || (size_t)n >= bufsz) return path;
    return buf;
}

typedef int (*posix_spawn_fn)(pid_t *, const char *,
                              const posix_spawn_file_actions_t *,
                              const posix_spawnattr_t *,
                              char *const[], char *const[]);

/**
 * @brief LD_PRELOAD interposer for @c posix_spawn that rewrites webkitgtk helper paths.
 *
 * Resolves the real @c posix_spawn via @c RTLD_NEXT on first call, then delegates
 * after passing @p path through ::remap.
 *
 * @param pid   Out-parameter for the spawned child's PID. Forwarded unchanged.
 * @param path  Absolute path to the executable. Rewritten via ::remap if it points
 *              at the host webkitgtk-6.0 helper directory.
 * @param fa    File actions. Forwarded unchanged.
 * @param attr  Spawn attributes. Forwarded unchanged.
 * @param argv  Argument vector. Forwarded unchanged.
 * @param envp  Environment vector. Forwarded unchanged.
 * @return Whatever the underlying @c posix_spawn returns (0 on success, errno on failure).
 *
 * @warning The lazy initialization of @c real is not thread-safe: concurrent first
 *          calls race on the @c dlsym lookup. The race is benign on architectures
 *          with atomic aligned pointer stores but is technically UB. Prefer a
 *          @c __attribute__((constructor)) for production use.
 * @warning If @c dlsym returns NULL (symbol not found), the subsequent indirect
 *          call will dereference a NULL function pointer.
 */
int posix_spawn(pid_t *pid, const char *path,
                const posix_spawn_file_actions_t *fa,
                const posix_spawnattr_t *attr,
                char *const argv[], char *const envp[])
{
    static posix_spawn_fn real = NULL;
    if (!real) real = (posix_spawn_fn)dlsym(RTLD_NEXT, "posix_spawn");
    char buf[4096];
    return real(pid, remap(path, buf, sizeof buf), fa, attr, argv, envp);
}

/**
 * @brief LD_PRELOAD interposer for @c posix_spawnp that rewrites webkitgtk helper paths.
 *
 * Like ::posix_spawn but the @p file argument is normally subject to @c PATH lookup.
 * Webkit's helpers are passed as absolute paths, so ::remap matching still applies.
 *
 * @param pid   Out-parameter for the spawned child's PID. Forwarded unchanged.
 * @param file  Executable name or path. Rewritten via ::remap on a host-prefix match.
 * @param fa    File actions. Forwarded unchanged.
 * @param attr  Spawn attributes. Forwarded unchanged.
 * @param argv  Argument vector. Forwarded unchanged.
 * @param envp  Environment vector. Forwarded unchanged.
 * @return Whatever the underlying @c posix_spawnp returns.
 *
 * @warning Same lazy-init race and NULL-from-dlsym caveats as ::posix_spawn.
 */
int posix_spawnp(pid_t *pid, const char *file,
                 const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *attr,
                 char *const argv[], char *const envp[])
{
    static posix_spawn_fn real = NULL;
    if (!real) real = (posix_spawn_fn)dlsym(RTLD_NEXT, "posix_spawnp");
    char buf[4096];
    return real(pid, remap(file, buf, sizeof buf), fa, attr, argv, envp);
}

typedef int (*execve_fn)(const char *, char *const[], char *const[]);

/**
 * @brief LD_PRELOAD interposer for @c execve that rewrites webkitgtk helper paths.
 *
 * On success @c execve does not return; on failure it returns -1 with @c errno set.
 * In glibc, @c execv, @c execvp, @c execvpe, @c execl, @c execle, and @c execlp are
 * all implemented on top of @c execve via the in-process call chain, so hooking
 * @c execve also catches them when the resolved path is absolute.
 *
 * @param path  Absolute path to the executable. Rewritten via ::remap on match.
 * @param argv  Argument vector. Forwarded unchanged.
 * @param envp  Environment vector. Forwarded unchanged.
 * @return Does not return on success; -1 with @c errno set on failure.
 *
 * @warning Same lazy-init race and NULL-from-dlsym caveats as ::posix_spawn.
 */
int execve(const char *path, char *const argv[], char *const envp[])
{
    static execve_fn real = NULL;
    if (!real) real = (execve_fn)dlsym(RTLD_NEXT, "execve");
    char buf[4096];
    return real(remap(path, buf, sizeof buf), argv, envp);
}

/**
 * @brief LD_PRELOAD interposer for @c execv that rewrites webkitgtk helper paths.
 *
 * Hooked defensively; in practice glibc routes @c execv through @c execve, which is
 * already interposed above. Kept to cover non-glibc loaders or future glibc changes.
 *
 * @param path  Absolute path to the executable. Rewritten via ::remap on match.
 * @param argv  Argument vector. Forwarded unchanged.
 * @return Does not return on success; -1 with @c errno set on failure.
 *
 * @warning Same lazy-init race and NULL-from-dlsym caveats as ::posix_spawn.
 */
int execv(const char *path, char *const argv[])
{
    static int (*real)(const char *, char *const[]) = NULL;
    if (!real) real = dlsym(RTLD_NEXT, "execv");
    char buf[4096];
    return real(remap(path, buf, sizeof buf), argv);
}

typedef void *(*dlopen_fn)(const char *, int);

/**
 * @brief LD_PRELOAD interposer for @c dlopen that rewrites webkitgtk paths.
 *
 * libwebkitgtk-6.0 dlopens its injected bundle .so from the hardcoded
 * /usr/lib/x86_64-linux-gnu/webkitgtk-6.0/injected-bundle/... path. This
 * interposer reroutes that load to the bundled copy inside the AppImage.
 *
 * @param filename  Library name or absolute path. Rewritten via ::remap on a
 *                  host-prefix match; passed through unchanged otherwise so the
 *                  dynamic linker's normal search rules still apply for plain
 *                  SONAMEs.
 * @param flags     dlopen flags (RTLD_LAZY / RTLD_NOW / RTLD_GLOBAL / ...).
 * @return Handle on success; @c NULL on failure (with @c dlerror() set).
 *
 * @warning Same lazy-init race and NULL-from-dlsym caveats as ::posix_spawn.
 */
void *dlopen(const char *filename, int flags)
{
    static dlopen_fn real = NULL;
    if (!real) real = (dlopen_fn)dlsym(RTLD_NEXT, "dlopen");
    char buf[4096];
    return real(remap(filename, buf, sizeof buf), flags);
}

typedef void *(*dlmopen_fn)(Lmid_t, const char *, int);

/**
 * @brief LD_PRELOAD interposer for @c dlmopen that rewrites webkitgtk paths.
 *
 * Same rationale as ::dlopen but for namespace-scoped loads. Hooked defensively
 * in case webkit ever uses isolated dlopen namespaces for plugin loading.
 *
 * @param lmid      Target link-map namespace. Forwarded unchanged.
 * @param filename  Library name or absolute path. Rewritten via ::remap on match.
 * @param flags     dlopen flags. Forwarded unchanged.
 * @return Handle on success; @c NULL on failure.
 *
 * @warning Same lazy-init race and NULL-from-dlsym caveats as ::posix_spawn.
 */
void *dlmopen(Lmid_t lmid, const char *filename, int flags)
{
    static dlmopen_fn real = NULL;
    if (!real) real = (dlmopen_fn)dlsym(RTLD_NEXT, "dlmopen");
    char buf[4096];
    return real(lmid, remap(filename, buf, sizeof buf), flags);
}
