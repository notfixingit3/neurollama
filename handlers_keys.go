package main

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	gossh "golang.org/x/crypto/ssh"
)

// ── SSH Key Store handlers ────────────────────────────────────────────────────

func listSSHKeysHandler(c *gin.Context) {
	keys, err := ListSSHKeys()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if keys == nil {
		keys = []SSHKeyMeta{}
	}
	c.JSON(http.StatusOK, keys)
}

func addSSHKeyHandler(c *gin.Context) {
	var body struct {
		Label      string `json:"label"`
		Username   string `json:"username"`
		PEMContent string `json:"pem_content"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}
	if body.Label == "" || body.Username == "" || body.PEMContent == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "label, username, and pem_content are required"})
		return
	}
	pemBytes := []byte(body.PEMContent)
	signer, err := gossh.ParsePrivateKey(pemBytes)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid or passphrase-protected private key (only unencrypted PEM keys are supported for storage)"})
		return
	}
	fingerprint := gossh.FingerprintSHA256(signer.PublicKey())
	meta, err := AddSSHKey(body.Label, body.Username, fingerprint, pemBytes)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	LogActivity("system", fmt.Sprintf("SSH key added: %s (%s)", body.Label, body.Username))
	c.JSON(http.StatusOK, meta)
}

func deleteSSHKeyHandler(c *gin.Context) {
	id := c.Param("id")
	if err := DeleteSSHKey(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	LogActivity("system", fmt.Sprintf("SSH key deleted: %s", id))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
