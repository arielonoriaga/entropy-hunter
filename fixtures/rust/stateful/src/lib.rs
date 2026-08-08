// Anti-pattern on purpose: 2^6 representable states, most invalid.
pub struct Connection {
    pub url: Option<String>,
    pub socket: Option<u32>,
    pub error: Option<String>,
    pub retries: Option<u8>,
    pub connected: bool,
    pub closing: bool,
}

// The fix: illegal states unrepresentable. Contributes nothing to the score.
pub enum ConnectionState {
    Disconnected,
    Connecting { url: String },
    Connected { url: String, socket: u32 },
    Failed { error: String },
}
