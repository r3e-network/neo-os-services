//! The production transport: blocking reqwest with rustls (no OpenSSL), a
//! 30-second timeout matching the JS relayer's RPC_TIMEOUT_MS. Behind the
//! `http` feature so vector tests build without a network stack.

use crate::HttpTransport;

/// Blocking reqwest transport (production).
#[derive(Debug, Clone)]
pub struct ReqwestHttpTransport {
    client: reqwest::blocking::Client,
    timeout_ms: u64,
}

impl ReqwestHttpTransport {
    pub fn new() -> Self {
        Self::with_timeout(crate::rpc::RPC_TIMEOUT_MS)
    }

    pub fn with_timeout(timeout_ms: u64) -> Self {
        ReqwestHttpTransport {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_millis(timeout_ms))
                .build()
                .expect("an HTTP client always builds"),
            timeout_ms,
        }
    }

    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }
}

impl Default for ReqwestHttpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for ReqwestHttpTransport {
    fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
        let response = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|error| error.to_string())?;
        Ok((status, text))
    }

    fn get(&self, url: &str) -> Result<(u16, String), String> {
        let response = self
            .client
            .get(url)
            .header("accept", "application/json")
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|error| error.to_string())?;
        Ok((status, text))
    }

    fn post_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
        body: &str,
    ) -> Result<(u16, String), String> {
        let response = self
            .client
            .post(url)
            .bearer_auth(token)
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .body(body.to_string())
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|error| error.to_string())?;
        Ok((status, text))
    }

    fn get_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
    ) -> Result<(u16, String), String> {
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .header("accept", "application/json")
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|error| error.to_string())?;
        Ok((status, text))
    }
}
