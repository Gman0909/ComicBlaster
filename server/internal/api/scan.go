package api

import "net/http"

func (s *server) handleTriggerScan(w http.ResponseWriter, r *http.Request) {
	go s.scanner.Scan()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "scan started"})
}

func (s *server) handleScanStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.scanner.Status())
}
