pub fn clamp_to_range(value: i32, min: i32, max: i32) -> i32 {
    if value < min {
        return min;
    }
    if value > max {
        return max;
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_within_range() {
        assert_eq!(clamp_to_range(5, 0, 10), 5);
    }
}
