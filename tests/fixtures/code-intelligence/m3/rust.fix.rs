// Phase 1 TextMate extractor fixture - Rust declarations.
// Plain test data; not meant to be a runnable program.

pub struct Widget {
    pub id: String,
    pub label: String,
}

pub enum Status {
    Idle,
    Active,
}

pub trait Greeter {
    fn greet(&self) -> String;
}

impl Widget {
    pub fn new(id: String, label: String) -> Self {
        Self { id, label }
    }

    pub fn describe(&self) -> String {
        format!("{}:{}", self.id, self.label)
    }
}

impl Greeter for Widget {
    fn greet(&self) -> String {
        format!("hello {}", self.label)
    }
}

fn standalone(value: i32) -> i32 {
    value + 1
}

async fn async_fetch() -> Result<Vec<Widget>, String> {
    Ok(Vec::new())
}
