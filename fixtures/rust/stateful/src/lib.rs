// Anti-pattern on purpose: 2^6 representable states, most invalid.
pub struct Connection {
    pub url: Option<String>,
    pub socket: Option<u32>,
    pub error: Option<String>,
    pub retries: Option<u8>,
    pub connected: bool,
    pub closing: bool,
}

// Anti-pattern on purpose: a flattened Order entity (order_* data clump).
pub struct Invoice {
    pub order_id: u64,
    pub order_date: String,
    pub order_total: i64,
    pub customer_name: String,
}

// The fix: illegal states unrepresentable. Contributes nothing to the score.
pub enum ConnectionState {
    Disconnected,
    Connecting { url: String },
    Connected { url: String, socket: u32 },
    Failed { error: String },
}
