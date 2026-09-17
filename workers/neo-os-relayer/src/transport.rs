//! HTTP transport implementation bridging reqwest to the three chain/store traits:
//! - `neo_os_chain_n3::HttpTransport`
//! - `neo_os_chain_evm::HttpTransport`
//! - `neo_os_relayer_store::HttpTransport`

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct RelayerHttpTransport {
    client: reqwest::blocking::Client,
    cancelled: Arc<AtomicBool>,
}

impl RelayerHttpTransport {
    pub fn new() -> Self {
        Self::with_timeout_ms(30_000)
    }

    pub fn with_timeout_ms(timeout_ms: u64) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .expect("Reqwest blocking client must build");
        RelayerHttpTransport {
            client,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn with_cancellation(timeout_ms: u64, cancelled: Arc<AtomicBool>) -> Self {
        let mut transport = Self::with_timeout_ms(timeout_ms);
        transport.cancelled = cancelled;
        transport
    }
    fn check_cancelled(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("relayer shutdown: no new HTTP work".into())
        } else {
            Ok(())
        }
    }
}

impl Default for RelayerHttpTransport {
    fn default() -> Self {
        Self::new()
    }
}

// Implement neo_os_chain_n3::HttpTransport
impl neo_os_chain_n3::HttpTransport for RelayerHttpTransport {
    fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
        self.check_cancelled()?;
        let response = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|e| e.to_string())?;
        Ok((status, text))
    }

    fn get(&self, url: &str) -> Result<(u16, String), String> {
        self.check_cancelled()?;
        let response = self
            .client
            .get(url)
            .header("accept", "application/json")
            .send()
            .map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|e| e.to_string())?;
        Ok((status, text))
    }

    fn post_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
        body: &str,
    ) -> Result<(u16, String), String> {
        self.check_cancelled()?;
        let response = self
            .client
            .post(url)
            .bearer_auth(token)
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .timeout(Duration::from_millis(timeout_ms))
            .body(body.to_owned())
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
        self.check_cancelled()?;
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .header("accept", "application/json")
            .timeout(Duration::from_millis(timeout_ms))
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|error| error.to_string())?;
        Ok((status, text))
    }
}

// Implement neo_os_chain_evm::HttpTransport
impl neo_os_chain_evm::HttpTransport for RelayerHttpTransport {
    fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
        self.check_cancelled()?;
        let response = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|e| e.to_string())?;
        Ok((status, text))
    }

    fn get(&self, url: &str) -> Result<(u16, String), String> {
        self.check_cancelled()?;
        let response = self
            .client
            .get(url)
            .header("accept", "application/json")
            .send()
            .map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|e| e.to_string())?;
        Ok((status, text))
    }

    fn post_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
        body: &str,
    ) -> Result<(u16, String), String> {
        <Self as neo_os_chain_n3::HttpTransport>::post_with_bearer(
            self, url, token, timeout_ms, body,
        )
    }

    fn get_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
    ) -> Result<(u16, String), String> {
        <Self as neo_os_chain_n3::HttpTransport>::get_with_bearer(self, url, token, timeout_ms)
    }
}

// Implement neo_os_relayer_store::HttpTransport
impl neo_os_relayer_store::HttpTransport for RelayerHttpTransport {
    fn request(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Result<(u16, String), String> {
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|error| format!("invalid HTTP method {method:?}: {error}"))?;
        self.check_cancelled()?;
        let mut req = self.client.request(method, url);
        for &(k, v) in headers {
            req = req.header(k, v);
        }
        if let Some(body) = body {
            req = req.body(body.to_owned());
        }
        let response = req.send().map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|e| e.to_string())?;
        Ok((status, text))
    }
}
