; VerixOS stage 1 - the boot sector.
;
; 512 bytes, loaded at 0x7C00 by the firmware, in real mode. It does exactly the
; four things a real boot sector does and nothing else: establish a stack, prove
; the BIOS works, load the next stage, and jump to it.
;
; The interesting part is that none of this is simulated. `int 0x13` below is
; decoded, dispatched to the firmware, and served by copying bytes out of a disk
; image held by the host; `int 0x10` goes through the same path. If the CHS
; arithmetic were wrong, the sector would not be found, `jc` would take the
; branch, and the machine would print a different message - which is why the
; loader's failure path is real code rather than an unreachable stub.

.code16

STAGE2_SECTORS  = 4          ; sectors of stage 2 to read
STAGE2_SECTOR   = 2          ; first sector of stage 2 (CHS numbering starts at 1)
LOAD_SEGMENT    = 0x0000
LOAD_OFFSET     = 0x8000     ; conventional address for stage 2

.text
start:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7c00            ; the stack grows down from the top of this sector
    cld

    mov si, msg_load
    call print

    ; ES:BX is the destination. ES is already zero, and saying so explicitly
    ; rather than relying on the reset state is what makes the read below
    ; independent of whatever ran before it.
    xor ax, ax
    mov es, ax
    mov bx, LOAD_OFFSET

    mov ah, 0x02              ; read sectors
    mov al, STAGE2_SECTORS
    mov ch, 0                 ; cylinder 0
    mov cl, STAGE2_SECTOR     ; sector 2
    mov dh, 0                 ; head 0
    mov dl, 0                 ; BIOS drive numbering: 0 is the first floppy
    int 0x13
    jc  disk_error

    mov si, msg_ok
    call print

    jmp far LOAD_SEGMENT:LOAD_OFFSET

disk_error:
    mov si, msg_fail
    call print
hang:
    hlt
    jmp hang

; print: write the NUL-terminated string at DS:SI through the BIOS teletype.
; The registers it uses are saved because the caller is mid-way through loading
; the kernel and has values in AX, BX and DX that it still needs.
print:
    push ax
    push bx
    push si
.next:
    lodsb
    test al, al
    jz  .done
    mov ah, 0x0e              ; teletype output
    int 0x10
    jmp .next
.done:
    pop si
    pop bx
    pop ax
    ret

.data
msg_load:  .asciz "VerixOS boot: loading stage 2\r\n"
msg_ok:    .asciz "VerixOS boot: stage 2 loaded\r\n"
msg_fail:  .asciz "VerixOS boot: stage 2 read failed\r\n"

; The BIOS looks for this signature before it will load the sector at all, so it
; is not decoration - a disk image without it would not boot on real hardware,
; and writing it here means the image this repository builds would work there too.
; `.org` takes an absolute address in image space, and the sector's last two bytes
; are 0x7C00 + 510.
.org 0x7dfe
.db 0x55, 0xaa