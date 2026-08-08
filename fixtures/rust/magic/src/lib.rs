// The fix: named constants don't count as magic.
pub const FREE_SHIPPING_THRESHOLD: u32 = 5000;

// Anti-pattern on purpose: unnamed literals and stringly-typed matching.
pub fn shipping(weight: u32, region: &str) -> u32 {
    if region == "north" {
        return weight * 7 + 250;
    }
    match region {
        "south" => weight * 9,
        _ => weight * 11 + 400,
    }
}
