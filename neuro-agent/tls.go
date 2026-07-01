package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"os"
	"time"
)

// ensureCert loads or generates a self-signed TLS cert and returns its SHA-256
// fingerprint (hex, no colons). The fingerprint is stored in NEUROLLAMA per
// node so the manager can pin the cert instead of trusting any self-signed cert.
func ensureCert(certFile, keyFile string) string {
	if _, err := os.Stat(certFile); err == nil {
		if pair, err := tls.LoadX509KeyPair(certFile, keyFile); err == nil {
			return fingerprint(pair.Certificate[0])
		}
	}
	return generateCert(certFile, keyFile)
}

func generateCert(certFile, keyFile string) string {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}

	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "neuro-agent"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		panic(err)
	}

	cf, _ := os.OpenFile(certFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	pem.Encode(cf, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	cf.Close()

	privDER, _ := x509.MarshalECPrivateKey(priv)
	kf, _ := os.OpenFile(keyFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	pem.Encode(kf, &pem.Block{Type: "EC PRIVATE KEY", Bytes: privDER})
	kf.Close()

	return fingerprint(der)
}

func fingerprint(derBytes []byte) string {
	h := sha256.Sum256(derBytes)
	return hex.EncodeToString(h[:])
}
