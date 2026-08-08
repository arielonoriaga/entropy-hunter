// Anti-pattern on purpose: three sibling ifs re-check is_admin() instead of
// nesting once inside a single guard with early-return branches.
pub fn resolve(is_admin: bool, can_edit: bool, can_delete: bool, can_export: bool) -> &'static str {
    if is_admin && can_edit {
        return "edit";
    }
    if is_admin && can_delete {
        return "delete";
    }
    if is_admin && can_export {
        return "export";
    }
    "none"
}
