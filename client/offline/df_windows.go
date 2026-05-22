//go:build windows

package offline

import "golang.org/x/sys/windows"

// freeDiskSpace returns bytes available on the volume holding `path`.
// Returns 0 if the call fails — Settings will just display "—" for
// free space in that case, which is acceptable since it's
// informational.
func freeDiskSpace(path string) int64 {
	pathPtr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0
	}
	var freeAvailable, totalBytes, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(pathPtr, &freeAvailable, &totalBytes, &totalFree); err != nil {
		return 0
	}
	// FreeBytesAvailable is what the calling user can actually use,
	// honoring quotas. Use that rather than totalFreeBytes.
	return int64(freeAvailable)
}
