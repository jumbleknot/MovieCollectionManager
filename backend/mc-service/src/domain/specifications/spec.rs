/// Generic Specification pattern trait.
/// Each specification encapsulates a single business rule.
///
/// `T: ?Sized` allows implementations over unsized types such as `str`.
pub trait Specification<T: ?Sized> {
    fn is_satisfied_by(&self, candidate: &T) -> bool;
}

/// Logical AND of two specifications: both must be satisfied.
pub struct AndSpec<T, A, B>
where
    T: ?Sized,
    A: Specification<T>,
    B: Specification<T>,
{
    left: A,
    right: B,
    _marker: std::marker::PhantomData<fn(&T)>,
}

impl<T, A, B> AndSpec<T, A, B>
where
    T: ?Sized,
    A: Specification<T>,
    B: Specification<T>,
{
    pub fn new(left: A, right: B) -> Self {
        Self {
            left,
            right,
            _marker: std::marker::PhantomData,
        }
    }
}

impl<T, A, B> Specification<T> for AndSpec<T, A, B>
where
    T: ?Sized,
    A: Specification<T>,
    B: Specification<T>,
{
    fn is_satisfied_by(&self, candidate: &T) -> bool {
        self.left.is_satisfied_by(candidate) && self.right.is_satisfied_by(candidate)
    }
}

/// Logical OR of two specifications: either must be satisfied.
pub struct OrSpec<T, A, B>
where
    T: ?Sized,
    A: Specification<T>,
    B: Specification<T>,
{
    left: A,
    right: B,
    _marker: std::marker::PhantomData<fn(&T)>,
}

impl<T, A, B> OrSpec<T, A, B>
where
    T: ?Sized,
    A: Specification<T>,
    B: Specification<T>,
{
    pub fn new(left: A, right: B) -> Self {
        Self {
            left,
            right,
            _marker: std::marker::PhantomData,
        }
    }
}

impl<T, A, B> Specification<T> for OrSpec<T, A, B>
where
    T: ?Sized,
    A: Specification<T>,
    B: Specification<T>,
{
    fn is_satisfied_by(&self, candidate: &T) -> bool {
        self.left.is_satisfied_by(candidate) || self.right.is_satisfied_by(candidate)
    }
}

/// Logical NOT of a specification: the inner spec must NOT be satisfied.
pub struct NotSpec<T, S>
where
    T: ?Sized,
    S: Specification<T>,
{
    inner: S,
    _marker: std::marker::PhantomData<fn(&T)>,
}

impl<T, S> NotSpec<T, S>
where
    T: ?Sized,
    S: Specification<T>,
{
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            _marker: std::marker::PhantomData,
        }
    }
}

impl<T, S> Specification<T> for NotSpec<T, S>
where
    T: ?Sized,
    S: Specification<T>,
{
    fn is_satisfied_by(&self, candidate: &T) -> bool {
        !self.inner.is_satisfied_by(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- Test helpers --

    struct AlwaysTrue;
    impl Specification<i32> for AlwaysTrue {
        fn is_satisfied_by(&self, _: &i32) -> bool {
            true
        }
    }

    struct AlwaysFalse;
    impl Specification<i32> for AlwaysFalse {
        fn is_satisfied_by(&self, _: &i32) -> bool {
            false
        }
    }

    // T012a — AndSpec

    #[test]
    fn and_spec_true_when_both_satisfied() {
        let spec = AndSpec::new(AlwaysTrue, AlwaysTrue);
        assert!(spec.is_satisfied_by(&0));
    }

    #[test]
    fn and_spec_false_when_left_not_satisfied() {
        let spec = AndSpec::new(AlwaysFalse, AlwaysTrue);
        assert!(!spec.is_satisfied_by(&0));
    }

    #[test]
    fn and_spec_false_when_right_not_satisfied() {
        let spec = AndSpec::new(AlwaysTrue, AlwaysFalse);
        assert!(!spec.is_satisfied_by(&0));
    }

    #[test]
    fn and_spec_false_when_neither_satisfied() {
        let spec = AndSpec::new(AlwaysFalse, AlwaysFalse);
        assert!(!spec.is_satisfied_by(&0));
    }

    // T012a — OrSpec

    #[test]
    fn or_spec_true_when_either_satisfied() {
        let spec = OrSpec::new(AlwaysTrue, AlwaysFalse);
        assert!(spec.is_satisfied_by(&0));
        let spec2 = OrSpec::new(AlwaysFalse, AlwaysTrue);
        assert!(spec2.is_satisfied_by(&0));
    }

    #[test]
    fn or_spec_false_when_neither_satisfied() {
        let spec = OrSpec::new(AlwaysFalse, AlwaysFalse);
        assert!(!spec.is_satisfied_by(&0));
    }

    // T012a — NotSpec

    #[test]
    fn not_spec_inverts_result() {
        let spec = NotSpec::new(AlwaysTrue);
        assert!(!spec.is_satisfied_by(&0));
        let spec2 = NotSpec::new(AlwaysFalse);
        assert!(spec2.is_satisfied_by(&0));
    }

    // T012a — combined chain (A and not B)

    #[test]
    fn combined_a_and_not_b_behaves_correctly() {
        // A = true, not B = true (B = false) → true
        let spec = AndSpec::new(AlwaysTrue, NotSpec::new(AlwaysFalse));
        assert!(spec.is_satisfied_by(&0));

        // A = true, not B = false (B = true) → false
        let spec2 = AndSpec::new(AlwaysTrue, NotSpec::new(AlwaysTrue));
        assert!(!spec2.is_satisfied_by(&0));

        // A = false, not B = true → false (A fails)
        let spec3 = AndSpec::new(AlwaysFalse, NotSpec::new(AlwaysFalse));
        assert!(!spec3.is_satisfied_by(&0));
    }
}
