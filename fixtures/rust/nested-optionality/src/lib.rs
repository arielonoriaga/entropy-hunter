// Legitimate PATCH tri-state on a public DTO: None = don't touch, Some(None)
// = clear, Some(Some(v)) = set. One occurrence, depth 1, public.
pub struct UpdateUser {
    pub name: Option<Option<String>>,
    pub email: String,
}

// A private, deeply-nested field: depth 2, not public.
struct InternalCache {
    entry: Option<Option<Option<u64>>>,
}

// Not nested optionality at all: Vec<Option<T>>, Option<Result<T, E>> are
// exempt by design (only direct Option<Option<...>> chains count).
pub struct Listing {
    pub items: Vec<Option<String>>,
    pub fallback: Option<Result<String, u32>>,
}
