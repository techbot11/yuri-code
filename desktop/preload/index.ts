// The renderer↔main bridge. A STUB for now: Task 4 replaces it with the boot
// window's state channel and Task 5 adds the tray reporter.
//
// It exists this early on purpose. main/index.ts already names it as the
// window's preload, and an Electron that cannot find its preload logs a load
// error on every launch — noise that would sit in the console through three
// tasks of supervisor debugging and hide a real error when one appears.
export {};
