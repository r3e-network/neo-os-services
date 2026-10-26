//! HTTP transport implementation bridging reqwest to the three chain/store traits:
//! - `neo_os_chain_n3::HttpTransport`
//! - `neo_os_chain_evm::HttpTransport`
//! - `neo_os_relayer_store::HttpTransport`

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

/// Host-owned capability. It supplies current credentials and only the
/// selected network's closed in-process routes; it never exposes host state.
pub trait RuntimeContext: Send + Sync {
    fn refresh_config(&self, base: &crate::config::RelayerConfig) -> Result<crate::config::RelayerConfig,String>;
    fn local_request(&self, method: &str, url: &str, bearer: Option<&str>, body: Option<&str>) -> Option<Result<(u16,String),String>>;
}

#[derive(Clone, Default)]
pub struct LoopRuntime {
    pub context: Option<Arc<dyn RuntimeContext>>,
    pub strict_drain: bool,
}

#[derive(Clone)]
pub struct RelayerHttpTransport {
    client: reqwest::blocking::Client,
    cancelled: Arc<AtomicBool>,
    context: Option<Arc<dyn RuntimeContext>>,
}
impl std::fmt::Debug for RelayerHttpTransport {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { f.write_str("RelayerHttpTransport") }
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
            context: None,
        }
    }
    pub fn with_cancellation(timeout_ms: u64, cancelled: Arc<AtomicBool>) -> Self {
        let mut transport = Self::with_timeout_ms(timeout_ms);
        transport.cancelled = cancelled;
        transport
    }
    pub fn with_runtime(timeout_ms: u64, cancelled: Arc<AtomicBool>, context: Option<Arc<dyn RuntimeContext>>) -> Self {
        let mut transport=Self::with_cancellation(timeout_ms,cancelled);
        if context.is_some() {
            transport.client=reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_millis(timeout_ms)).build().expect("Reqwest blocking client must build");
        }
        transport.context=context;
        transport
    }
    fn local(&self,method:&str,url:&str,bearer:Option<&str>,body:Option<&str>)->Option<Result<(u16,String),String>> {
        self.context.as_ref().and_then(|c|c.local_request(method,url,bearer,body))
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
    fn post_local(&self, url: &str, body: &str) -> Result<(u16, String), String> {
        self.check_cancelled()?;
        neo_os_chain_n3::rpc::validate_local_chain_url(url)?;
        let response = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?
            .post(url)
            .header("content-type", "application/json")
            .body(body.to_owned())
            .send()
            .map_err(|e| e.to_string())?;
        Ok((
            response.status().as_u16(),
            response.text().map_err(|e| e.to_string())?,
        ))
    }

    fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
        self.check_cancelled()?;
        if let Some(result)=self.local("POST",url,None,Some(body)) { return result; }
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
        if let Some(result)=self.local("GET",url,None,None) { return result; }
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
        if let Some(result)=self.local("POST",url,Some(token),Some(body)) { return result; }
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
        if let Some(result)=self.local("GET",url,Some(token),None) { return result; }
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
        if let Some(result)=self.local("POST",url,None,Some(body)) { return result; }
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
        if let Some(result)=self.local("GET",url,None,None) { return result; }
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
