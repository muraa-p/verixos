; VerixOS - the smallest program that proves three things at once.
;
; Run it with:
;
;     npm start -- run examples/hello.asm --trace
;
; It prints through the BIOS, which means the program is making real `int 0x10`
; calls that the firmware decodes and services against the VGA adapter. If the
; console shows the lines below, then the assembler produced working machine
; code, the decoder read it back, the interpreter executed it, and the firmware
; wrote the characters into real video memory - in that order.

.code16

.text
start:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7c00
    cld

    ; Called twice on purpose. Two calls to the same forward label is the shape
    ; that a layout pass has to get right twice, and this file would not have
    ; assembled before that was fixed.
    mov si, message
    call print
    mov si, message2
    call print

    ; Prove the arithmetic works too, not just the video path. The result stays in
    ; AX for the caller to inspect, so `verix run` prints 0x2345 at the end.
    mov ax, 0x1234
    add ax, 0x1111
    hlt

; print: write the NUL-terminated string at DS:SI to the console.
;
; `lodsb` reads through DS, which is zero, so SI is a plain offset. The routine
; saves the registers the caller is using, because a helper that clobbers them is
; a bug that only shows up in a larger program.
print:
    push ax
    push si
.next:
    lodsb
    test al, al
    jz  .done
    mov ah, 0x0e              ; BIOS teletype output
    int 0x10
    jmp .next
.done:
    pop si
    pop ax
    ret

.data
; The string lives immediately after the code. Naming the label rather than a
; constant is what makes the layout work at any origin: `.data` follows `.text`,
; so hard-coding an address here would break the moment the program grew.
message:
    .asciz "Hello from VerixOS.\r\n"
message2:
    .asciz "This ran on the interpreter.\r\n"