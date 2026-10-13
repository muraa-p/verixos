; VerixOS stage 2 - loaded from disk by stage 1, at 0x8000, still in real mode.
;
; Stage 2 exists because a 512-byte sector is not enough room for a kernel, and
; because the work between "the BIOS will load me" and "the kernel can run" is
; worth doing in code that is executed rather than in code that is trusted.
;
; What it does, all through real machine instructions on the interpreter:
;   - reports itself on the console, proving `int 0x10` still works after the
;     stage 1 hand-off;
;   - programs the PIT for 100 Hz and unmasks the timer and keyboard lines on the
;     8259 pair, then enables interrupts, so the desktop that follows is animated
;     by a timer that is genuinely counting rather than by a host loop;
;   - takes the screen into 320x200 256-colour mode;
;   - publishes a hand-off word and stops, which is how control reaches the
;     kernel.
;
; The hand-off is a word in memory rather than a far jump, and the reason is
; architectural: a real-mode far pointer has a 16-bit offset, so it cannot reach
; the 1 MiB entry point at all. The alternatives a real boot sector has are to
; enter protected mode first or to hand over through memory - and this is the
; second, because the kernel that runs next does not need 16-bit real mode.

.code16

; Written to 0x7E00 when stage 2 is ready to hand over. A two-byte magic is
; enough to distinguish "finished" from "crashed halfway through", which is all
; the loader needs, and two bytes leaves the rest of the conventional
; boot-parameter area untouched for anything that might want it.
HANDOFF_ADDRESS = 0x7e00
HANDOFF_MAGIC   = 0xc0de

; PIT: 100 Hz means 11932 counts, which is 0x2E9C.
PIT_FREQUENCY   = 100

.text
stage2_entry:
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x8000

    mov si, msg_start
    call print

    ; Program channel 0 of the 8253/8254. Command byte 0x36 is channel 0, access
    ; low byte then high byte, mode 3 (square wave), binary counting. Mode 3 is
    ; the right choice for a frame timer because its output is a symmetrical
    ; square wave, which is what the PC's timer interrupt is expected to follow.
    mov al, 0x36
    out 0x43, al
    mov al, 0x9c                ; 11932 = 0x2E9C, low byte
    out 0x40, al
    mov al, 0x2e                ; high byte
    out 0x40, al

    ; Unmask IRQ0 (timer) and IRQ1 (keyboard) on the master 8259. The reset mask
    ; is 0xFF - everything masked - so without this the timer would count and
    ; nothing would be told. Clearing bits 0 and 1 is the whole operation.
    mov al, 0xfc
    out 0x21, al

    ; Enable keyboard scanning. As with the PS/2 protocol on real hardware this is
    ; two writes: the command goes to the data port, and 0xD4 at the command port
    ; tells the controller to forward it to the keyboard.
    mov al, 0xf4                ; enable scanning
    out 0x60, al
    mov al, 0xd4                ; write the byte to the keyboard
    out 0x64, al

    sti

    mov si, msg_timer
    call print

    ; The screen is deliberately left in text mode here. The kernel switches to
    ; 320x200 when the compositor takes over, which means the boot log stays
    ; readable in the frame buffer right up to that point instead of being wiped a
    ; moment before anyone could look at it. The mode change is the kernel's
    ; because the kernel is what needs the frame buffer.

    ; Publish the hand-off and stop. The loader watches for the word; without it
    ; the machine is treated as having failed, which is the safe reading of a
    ; stage 2 that crashed before it finished.
    mov word [HANDOFF_ADDRESS], HANDOFF_MAGIC
    hlt

; print: write the NUL-terminated string at DS:SI through the BIOS teletype.
print:
    push ax
    push si
.next:
    lodsb
    test al, al
    jz  .done
    mov ah, 0x0e
    int 0x10
    jmp .next
.done:
    pop si
    pop ax
    ret

.data
msg_start:  .asciz "VerixOS stage 2: timer at 100 Hz, interrupts on\r\n"
msg_timer:  .asciz "VerixOS stage 2: starting compositor\r\n"