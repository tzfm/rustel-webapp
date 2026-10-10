//! The pattern table. A handle is a u32 the host keeps inside its pattern
//! object. The low 24 bits index a slot, the high 8 bits count how often the
//! slot was reused, so a stale handle misses instead of reaching a new
//! pattern.

use rustel_core::Pattern;

const INDEX_BITS: u32 = 24;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;

#[derive(Default)]
pub struct Table {
    slots: Vec<Slot>,
    free: Vec<u32>,
    live: usize,
}

#[derive(Default)]
struct Slot {
    pattern: Option<Pattern>,
    generation: u8,
}

impl Table {
    pub fn insert(&mut self, pattern: Pattern) -> u32 {
        self.live += 1;
        if let Some(index) = self.free.pop() {
            let slot = &mut self.slots[index as usize];
            slot.pattern = Some(pattern);
            return u32::from(slot.generation) << INDEX_BITS | index;
        }
        let index = self.slots.len() as u32;
        assert!(index <= INDEX_MASK, "pattern table is full");
        self.slots.push(Slot {
            pattern: Some(pattern),
            generation: 0,
        });
        index
    }

    /// A clone of the pattern. The clone is cheap, and no borrow of the
    /// table stays live when the caller crosses to the host.
    pub fn get(&self, handle: u32) -> Option<Pattern> {
        let slot = self.slots.get((handle & INDEX_MASK) as usize)?;
        (u32::from(slot.generation) == handle >> INDEX_BITS)
            .then(|| slot.pattern.clone())
            .flatten()
    }

    /// Free a handle. A handle which is not live is ignored, so a second free
    /// and a free from a finalizer after an explicit free are harmless.
    pub fn free(&mut self, handle: u32) {
        let index = handle & INDEX_MASK;
        let Some(slot) = self.slots.get_mut(index as usize) else {
            return;
        };
        if u32::from(slot.generation) != handle >> INDEX_BITS || slot.pattern.is_none() {
            return;
        }
        slot.pattern = None;
        slot.generation = slot.generation.wrapping_add(1);
        self.free.push(index);
        self.live -= 1;
    }

    /// How many handles are live.
    pub fn live(&self) -> usize {
        self.live
    }
}
