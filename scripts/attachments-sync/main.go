// instar-attachments-sync
//
// Purpose-built binary for mirroring iMessage photo attachments to a
// readable location for the Instar agent. This binary is granted Full
// Disk Access in macOS Privacy settings — nothing else needs it.
//
// What it does (and only what it does):
//   1. On startup: hardlink all existing image/video attachments from
//      ~/Library/Messages/Attachments/ to DEST_DIR.
//   2. Continuously watch for new files via FSEvents and hardlink them.
//   3. Prune dead hardlinks (source deleted, link count == 1).
//
// Naming convention: {first8ofUUID}__{original-filename}
// This mirrors the bash script it replaces, so existing hardlinks remain valid.

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
)

var (
	homeDir  = os.Getenv("HOME")
	srcDir   = filepath.Join(homeDir, "Library/Messages/Attachments")
	destDir  string
	logFile  string
)

// Supported extensions to mirror
var exts = map[string]bool{
	".jpeg": true, ".jpg": true, ".png": true, ".heic": true,
	".mov": true, ".mp4": true, ".pdf": true, ".gif": true,
	".caf": true, ".m4a": true, ".3gpp": true,
}

func main() {
	// Resolve paths relative to this binary's location.
	// Binary lives at <agentRoot>/.instar/bin/instar-attachments-sync
	// So .instar dir is filepath.Dir(filepath.Dir(exe))
	exe, err := os.Executable()
	if err != nil {
		log.Fatalf("cannot resolve executable path: %v", err)
	}
	dotInstar := filepath.Dir(filepath.Dir(exe)) // <agentRoot>/.instar
	destDir = filepath.Join(dotInstar, "imessage/attachments")
	logFile = filepath.Join(dotInstar, "logs/attachments-watcher.log")

	// Override via env for testing
	if v := os.Getenv("ATTACHMENTS_DEST"); v != "" {
		destDir = v
	}
	if v := os.Getenv("ATTACHMENTS_LOG"); v != "" {
		logFile = v
	}

	if err := os.MkdirAll(destDir, 0755); err != nil {
		log.Fatalf("cannot create dest dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(logFile), 0755); err != nil {
		log.Fatalf("cannot create log dir: %v", err)
	}

	lf, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Fatalf("cannot open log: %v", err)
	}
	log.SetOutput(lf)
	log.SetFlags(0) // we write our own timestamps

	logMsg("instar-attachments-sync starting")
	logMsg("src=%s dest=%s", srcDir, destDir)

	// Initial sync
	n, err := syncOnce()
	if err != nil {
		logMsg("initial sync error: %v", err)
	} else {
		logMsg("initial sync: linked %d new files", n)
	}

	// Watch for new files
	if err := watch(); err != nil {
		logMsg("watcher error: %v", err)
		os.Exit(1)
	}
}

// syncOnce walks srcDir and hardlinks any new supported files to destDir.
// Returns count of newly linked files.
func syncOnce() (int, error) {
	count := 0
	err := filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			// Skip dirs/files we can't read — log once at top level
			if path == srcDir {
				return fmt.Errorf("cannot read source dir %s: %w", srcDir, err)
			}
			return nil
		}
		if info.IsDir() || strings.HasPrefix(info.Name(), ".") {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(info.Name()))
		if !exts[ext] {
			return nil
		}
		if linked, err := linkFile(path); err != nil {
			logMsg("link error %s: %v", path, err)
		} else if linked {
			count++
		}
		return nil
	})
	// Prune dead hardlinks
	pruneDeadLinks()
	return count, err
}

// linkFile creates a hardlink in destDir for the given source file.
// Returns true if a new link was created, false if it already existed.
func linkFile(src string) (bool, error) {
	base := filepath.Base(src)
	// Parent dir is the UUID directory
	uuid := filepath.Base(filepath.Dir(src))
	prefix := uuid
	if len(prefix) > 8 {
		prefix = prefix[:8]
	}
	destName := prefix + "__" + base
	dest := filepath.Join(destDir, destName)

	// Check if already linked (same inode)
	if isSameInode(src, dest) {
		return false, nil
	}

	// Remove stale dest if present
	if _, err := os.Lstat(dest); err == nil {
		os.Remove(dest)
	}

	if err := os.Link(src, dest); err != nil {
		return false, err
	}
	return true, nil
}

// isSameInode returns true if both paths exist and share an inode.
func isSameInode(a, b string) bool {
	sa, err := os.Stat(a)
	if err != nil {
		return false
	}
	sb, err := os.Stat(b)
	if err != nil {
		return false
	}
	sia, ok1 := sa.Sys().(*syscall.Stat_t)
	sib, ok2 := sb.Sys().(*syscall.Stat_t)
	return ok1 && ok2 && sia.Ino == sib.Ino
}

// pruneDeadLinks removes hardlinks whose source has been deleted (link count == 1).
func pruneDeadLinks() {
	entries, err := os.ReadDir(destDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		path := filepath.Join(destDir, e.Name())
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Nlink == 1 {
			os.Remove(path)
		}
	}
}

// watch uses fsnotify to watch srcDir and re-runs syncOnce on changes.
func watch() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("fsnotify: %w", err)
	}
	defer watcher.Close()

	// Watch top-level src dir; we'll add subdirs as they appear
	if err := watcher.Add(srcDir); err != nil {
		return fmt.Errorf("watch %s: %w", srcDir, err)
	}

	// Also watch existing subdirs (Messages uses 2-level nesting)
	_ = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && info.IsDir() {
			watcher.Add(path) //nolint
		}
		return nil
	})

	logMsg("watching %s", srcDir)

	debounce := time.NewTimer(0)
	<-debounce.C // drain initial fire

	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return fmt.Errorf("watcher channel closed")
			}
			// Watch new subdirectories as they're created
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					watcher.Add(event.Name) //nolint
				}
			}
			// Debounce: wait 500ms after last event before syncing
			debounce.Reset(500 * time.Millisecond)

		case err, ok := <-watcher.Errors:
			if !ok {
				return fmt.Errorf("watcher error channel closed")
			}
			logMsg("watcher error: %v", err)

		case <-debounce.C:
			n, err := syncOnce()
			if err != nil {
				logMsg("sync error: %v", err)
			} else if n > 0 {
				logMsg("linked %d new files", n)
			}
		}
	}
}

func logMsg(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("%s %s", time.Now().UTC().Format("2006-01-02T15:04:05Z"), msg)
}
