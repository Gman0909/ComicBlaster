//go:build !windows

package offline

import "syscall"

// freeDiskSpace returns bytes available on the volume holding `path`.
// Returns 0 if the call fails — Settings will just display "—" for
// free space in that case, which is acceptable since it's
// informational.
func freeDiskSpace(path string) int64 {
	var s syscall.Statfs_t
	if err := syscall.Statfs(path, &s); err != nil {
		return 0
	}
	// Bavail is blocks available to a non-privileged process; Bsize
	// is the block size. Both are unsigned so the cast is safe for
	// any sane filesystem.
	return int64(s.Bavail) * int64(s.Bsize)
}
