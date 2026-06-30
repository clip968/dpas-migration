# 2026-06-29 io_uring 커널 코드 경로 직관 보고서

이 문서는 `dpas-kernel`의 현재 소스 기준, 즉 `7.1.0-rc4`에서 `io_uring` read/write 요청 하나가 어디서 시작해 어떤 함수들을 지나 block layer와 DPAS polling hook까지 내려가는지 설명한다.

기준 버전:

```text
dpas-kernel/Makefile
  VERSION = 7
  PATCHLEVEL = 1
  SUBLEVEL = 0
  EXTRAVERSION = -rc4
```

설명 대상은 일반 `IORING_OP_READ` / `IORING_OP_WRITE` 경로다. `IORING_OP_URING_CMD`는 별도 command/passthrough 경로라 마지막 주의점에서 따로 분리한다.

핵심 요약:

```text
userspace
  io_uring_enter(fd, to_submit, ...)
        |
        v
dpas-kernel/io_uring/io_uring.c
  io_uring_enter()
    -> io_submit_sqes()
    -> io_submit_sqe()
    -> io_init_req()
    -> io_queue_sqe()
    -> io_issue_sqe()
        |
        v
dpas-kernel/io_uring/opdef.c
  opcode table
    IORING_OP_READ  -> io_read()
    IORING_OP_WRITE -> io_write()
        |
        v
dpas-kernel/io_uring/rw.c
  io_read()/io_write()
    -> io_rw_init_file()
       IORING_SETUP_IOPOLL이면
       req->flags |= REQ_F_IOPOLL
       kiocb->ki_flags |= IOCB_HIPRI
    -> file->f_op->read_iter/write_iter()
        |
        +-------------------------------+
        |                               |
        v                               v
raw block device                  filesystem file, 예: XFS
  block/fops.c                      fs/xfs/xfs_file.c
  blkdev_read_iter()                xfs_file_read_iter()
  blkdev_write_iter()               xfs_file_write_iter()
  blkdev_direct_IO()                xfs_file_dio_read/write()
        |                               |
        v                               v
  __blkdev_direct_IO_async()        fs/iomap/direct-io.c
                                    iomap_dio_rw()
                                    iomap_dio_submit_bio()
        |                               |
        +---------------+---------------+
                        v
dpas-kernel/block/blk-core.c
  blk_dpas_prepare_bio()
    -> mode별로 REQ_POLLED 유지/제거
                        |
                        v
  submit_bio()
    -> blk_mq_submit_bio()
    -> request 생성
    -> blk_mq_start_request()
       bio->bi_cookie = rq->mq_hctx->queue_num
                        |
                        v
completion poll
  io_iopoll_check()
    -> io_do_iopoll()
    -> file->f_op->iopoll()
    -> iocb_bio_iopoll()
    -> bio_poll()
    -> blk_mq_poll_bio()
    -> __blk_hctx_poll()
    -> q->mq_ops->poll()
    -> nvme_poll()
```

중요한 관점은 `io_uring`이 block layer를 특별한 전용 경로로 우회하지 않는다는 점이다. 일반 read/write SQE는 결국 `struct kiocb`와 `file->f_op->read_iter/write_iter` 경계로 내려간다. 그 다음 대상 파일이 raw block device인지, XFS 같은 파일시스템 파일인지에 따라 direct I/O 구현만 갈라진다.

## 1. syscall entry가 io_uring context를 찾는다

위치:

- `dpas-kernel/io_uring/io_uring.c:SYSCALL_DEFINE6(io_uring_enter)`

코드:

```c
SYSCALL_DEFINE6(io_uring_enter, unsigned int, fd, u32, to_submit,
		u32, min_complete, u32, flags, const void __user *, argp,
		size_t, argsz)
{
	struct io_ring_ctx *ctx;
	struct file *file;
	long ret;

	if (unlikely(flags & ~IORING_ENTER_FLAGS))
		return -EINVAL;

	file = io_uring_ctx_get_file(fd, flags & IORING_ENTER_REGISTERED_RING);
	if (IS_ERR(file))
		return PTR_ERR(file);
	ctx = file->private_data;
```

변수 변화:

```text
입력:
  fd = io_uring ring fd
  to_submit = userspace가 제출하려는 SQE 수
  flags = IORING_ENTER_* flags

실행:
  io_uring_ctx_get_file(fd, ...)
  ctx = file->private_data

실행 후:
  커널은 이 syscall이 어느 io_ring_ctx에 대한 submit/getevents인지 알게 된다.
```

이 단계의 의미:

- 여기서 아직 read/write 요청을 해석하지 않는다.
- 먼저 ring fd를 `struct file`로 찾고, 그 file의 `private_data`에서 `struct io_ring_ctx`를 꺼낸다.

그림:

```text
userspace fd
    |
    v
io_uring_ctx_get_file()
    |
    v
struct file for ring
    |
    +-- private_data --> struct io_ring_ctx
```

## 2. 일반 submit path는 io_submit_sqes()로 들어간다

위치:

- `dpas-kernel/io_uring/io_uring.c:SYSCALL_DEFINE6(io_uring_enter)`
- `dpas-kernel/io_uring/io_uring.c:io_submit_sqes()`

코드:

```c
} else if (to_submit) {
	ret = io_uring_add_tctx_node(ctx);
	if (unlikely(ret))
		goto out;

	mutex_lock(&ctx->uring_lock);
	ret = io_submit_sqes(ctx, to_submit);
	if (ret != to_submit) {
		mutex_unlock(&ctx->uring_lock);
		goto out;
	}
```

```c
int io_submit_sqes(struct io_ring_ctx *ctx, unsigned int nr)
{
	entries = min(nr, entries);
	...
	do {
		const struct io_uring_sqe *sqe;
		struct io_kiocb *req;

		if (unlikely(!io_alloc_req(ctx, &req)))
			break;
		if (unlikely(!io_get_sqe(ctx, &sqe))) {
			io_req_add_to_cache(req, ctx);
			break;
		}

		if (unlikely(io_submit_sqe(ctx, req, sqe, &left)) &&
		    !(ctx->flags & IORING_SETUP_SUBMIT_ALL)) {
			left--;
			break;
		}
	} while (--left);
```

변수 변화:

```text
입력:
  ctx = ring context
  nr = to_submit
  SQ ring에는 userspace가 써둔 SQE들이 있음

실행:
  io_alloc_req()로 struct io_kiocb 할당
  io_get_sqe()로 SQE pointer 획득
  io_submit_sqe(ctx, req, sqe, &left)

실행 후:
  SQE 하나가 커널 내부 request인 io_kiocb 하나로 변환되기 시작한다.
```

직관:

```text
SQE는 userspace가 써둔 요청 설명서
io_kiocb는 커널이 실제로 들고 다니는 요청 객체
```

## 3. io_init_req()가 SQE의 opcode와 flags를 req에 복사한다

위치:

- `dpas-kernel/io_uring/io_uring.c:io_submit_sqe()`
- `dpas-kernel/io_uring/io_uring.c:io_init_req()`

코드:

```c
static inline int io_submit_sqe(struct io_ring_ctx *ctx, struct io_kiocb *req,
			 const struct io_uring_sqe *sqe, unsigned int *left)
{
	ret = io_init_req(ctx, req, sqe, left);
	if (unlikely(ret))
		return io_submit_fail_init(sqe, req, ret);
	...
	io_queue_sqe(req, IO_URING_F_INLINE);
	return 0;
}
```

```c
req->ctx = ctx;
req->opcode = opcode = READ_ONCE(sqe->opcode);
sqe_flags = READ_ONCE(sqe->flags);
req->flags = (__force io_req_flags_t) sqe_flags;
req->cqe.user_data = READ_ONCE(sqe->user_data);
req->file = NULL;
req->tctx = current->io_uring;
req->async_data = NULL;
```

변수 변화:

```text
입력 SQE:
  sqe->opcode = IORING_OP_READ 또는 IORING_OP_WRITE
  sqe->flags = IOSQE_* flags
  sqe->user_data = userspace completion 식별자

실행 후 req:
  req->ctx = ctx
  req->opcode = sqe->opcode
  req->flags = sqe->flags
  req->cqe.user_data = sqe->user_data
  req->file = 아직 NULL
```

이 단계의 의미:

- SQE의 opcode가 이후 `io_issue_defs[opcode]` table을 고르는 index가 된다.
- `user_data`는 나중에 completion queue entry에서 userspace가 요청을 식별하는 값이다.

## 4. opcode table이 READ/WRITE를 io_read()/io_write()로 연결한다

위치:

- `dpas-kernel/io_uring/opdef.c:io_issue_defs[]`

코드:

```c
[IORING_OP_READ] = {
	.needs_file		= 1,
	.unbound_nonreg_file	= 1,
	.pollin			= 1,
	.buffer_select		= 1,
	.plug			= 1,
	.audit_skip		= 1,
	.ioprio			= 1,
	.iopoll			= 1,
	.async_size		= sizeof(struct io_async_rw),
	.prep			= io_prep_read,
	.issue			= io_read,
},
```

```c
[IORING_OP_WRITE] = {
	.needs_file		= 1,
	.hash_reg_file		= 1,
	.unbound_nonreg_file	= 1,
	.pollout		= 1,
	.plug			= 1,
	.audit_skip		= 1,
	.ioprio			= 1,
	.iopoll			= 1,
	.async_size		= sizeof(struct io_async_rw),
	.prep			= io_prep_write,
	.issue			= io_write,
},
```

변수 변화:

```text
입력:
  req->opcode = IORING_OP_READ

실행:
  def = &io_issue_defs[req->opcode]

실행 후:
  def->prep = io_prep_read
  def->issue = io_read
  def->needs_file = 1
  def->iopoll = 1
```

이 단계의 의미:

- read/write는 file이 필요한 opcode다.
- `iopoll = 1`이므로 ring이 `IORING_SETUP_IOPOLL`일 때 이 opcode는 poll 가능한 요청으로 취급될 수 있다.

그림:

```text
req->opcode
    |
    v
io_issue_defs[opcode]
    |
    +-- prep  --> io_prep_read / io_prep_write
    +-- issue --> io_read      / io_write
```

## 5. io_issue_sqe()가 file을 붙이고 issue handler를 호출한다

위치:

- `dpas-kernel/io_uring/io_uring.c:io_issue_sqe()`
- `dpas-kernel/io_uring/io_uring.c:__io_issue_sqe()`

코드:

```c
static int io_issue_sqe(struct io_kiocb *req, unsigned int issue_flags)
{
	const struct io_issue_def *def = &io_issue_defs[req->opcode];
	int ret;

	if (unlikely(!io_assign_file(req, def, issue_flags)))
		return -EBADF;

	ret = __io_issue_sqe(req, issue_flags, def);
	...
	if (ret == IOU_ISSUE_SKIP_COMPLETE) {
		ret = 0;

		if (req->flags & REQ_F_IOPOLL)
			io_iopoll_req_issued(req, issue_flags);
	}
	return ret;
}
```

```c
ret = def->issue(req, issue_flags);
```

변수 변화:

```text
입력:
  req->opcode = IORING_OP_READ
  def->issue = io_read
  req->file = NULL

실행:
  io_assign_file(req, def, issue_flags)
  def->issue(req, issue_flags)

실행 후:
  req->file = SQE fd가 가리키는 struct file
  io_read(req, issue_flags)가 실행됨
```

이 단계의 의미:

- `io_uring` core는 read/write의 세부 구현을 직접 알지 않는다.
- opcode table의 `issue` 함수로 위임한다.
- IOPOLL 요청이 `-EIOCBQUEUED` 계열로 발행되면 `io_iopoll_req_issued()`로 `ctx->iopoll_list`에 걸린다.

## 6. io_rw_init_file()에서 IOPOLL 요청이 IOCB_HIPRI가 된다

위치:

- `dpas-kernel/io_uring/rw.c:io_rw_init_file()`

코드:

```c
if (ctx->flags & IORING_SETUP_IOPOLL) {
	if (!(kiocb->ki_flags & IOCB_DIRECT) || !file->f_op->iopoll)
		return -EOPNOTSUPP;
	req->flags |= REQ_F_IOPOLL;
	kiocb->private = NULL;
	kiocb->ki_flags |= IOCB_HIPRI;
	req->iopoll_completed = 0;
	if (ctx->flags & IORING_SETUP_HYBRID_IOPOLL) {
		req->flags &= ~REQ_F_IOPOLL_STATE;
		req->iopoll_start = ktime_get_ns();
	}
} else {
	if (kiocb->ki_flags & IOCB_HIPRI)
		return -EINVAL;
}
```

변수 변화:

```text
입력:
  ctx->flags has IORING_SETUP_IOPOLL
  file->f_op->iopoll exists
  kiocb->ki_flags has IOCB_DIRECT

실행 후:
  req->flags |= REQ_F_IOPOLL
  kiocb->private = NULL
  kiocb->ki_flags |= IOCB_HIPRI
  req->iopoll_completed = 0
```

이 단계가 중요한 이유:

- `io_uring`의 IOPOLL 설정이 block/filesystem direct I/O 경로에서는 `IOCB_HIPRI`로 표현된다.
- 뒤쪽 DPAS hook은 이 `IOCB_HIPRI`를 보고 `bio`에 `REQ_POLLED`를 붙일지 말지 결정한다.

직관:

```text
io_uring ring flag:
  IORING_SETUP_IOPOLL

io_uring request flag:
  REQ_F_IOPOLL

kiocb flag:
  IOCB_HIPRI

bio flag:
  REQ_POLLED
```

## 7. io_read()/io_write()는 file->f_op 경계로 내려간다

위치:

- `dpas-kernel/io_uring/rw.c:__io_read()`
- `dpas-kernel/io_uring/rw.c:io_write()`
- `dpas-kernel/io_uring/rw.c:io_iter_do_read()`

코드:

```c
ret = io_rw_init_file(req, FMODE_READ, READ);
...
ret = io_iter_do_read(rw, &io->iter);
```

```c
static inline int io_iter_do_read(struct io_rw *rw, struct iov_iter *iter)
{
	struct file *file = rw->kiocb.ki_filp;

	if (likely(file->f_op->read_iter))
		return file->f_op->read_iter(&rw->kiocb, iter);
	else if (file->f_op->read)
		return loop_rw_iter(READ, rw, iter);
	else
		return -EINVAL;
}
```

```c
if (likely(req->file->f_op->write_iter))
	ret2 = req->file->f_op->write_iter(kiocb, &io->iter);
else if (req->file->f_op->write)
	ret2 = loop_rw_iter(WRITE, rw, &io->iter);
else
	ret2 = -EINVAL;
```

변수 변화:

```text
입력:
  req->file = target file
  rw->kiocb.ki_filp = req->file
  io->iter = userspace buffer를 나타내는 iov_iter

실행:
  file->f_op->read_iter(&rw->kiocb, &io->iter)
  또는
  file->f_op->write_iter(&rw->kiocb, &io->iter)

실행 후:
  io_uring generic layer를 벗어나 target file type의 구현으로 내려간다.
```

이 단계의 의미:

- 여기서부터는 대상 file이 무엇인지가 중요하다.
- raw block device면 `block/fops.c`.
- XFS 파일이면 `fs/xfs/xfs_file.c`.

## 8. raw block device는 blkdev_read_iter()/blkdev_write_iter()로 간다

위치:

- `dpas-kernel/block/fops.c:def_blk_fops`
- `dpas-kernel/block/fops.c:blkdev_read_iter()`
- `dpas-kernel/block/fops.c:blkdev_write_iter()`

코드:

```c
const struct file_operations def_blk_fops = {
	.open		= blkdev_open,
	.release	= blkdev_release,
	.llseek		= blkdev_llseek,
	.read_iter	= blkdev_read_iter,
	.write_iter	= blkdev_write_iter,
	.iopoll		= iocb_bio_iopoll,
	...
};
```

```c
if (iocb->ki_flags & IOCB_DIRECT) {
	ret = blkdev_direct_IO(iocb, to);
	...
}
```

```c
if (iocb->ki_flags & IOCB_DIRECT) {
	ret = blkdev_direct_write(iocb, from);
	...
}
```

변수 변화:

```text
입력:
  file = raw block device file
  file->f_op = def_blk_fops
  kiocb->ki_flags has IOCB_DIRECT

실행:
  blkdev_read_iter()/blkdev_write_iter()
  -> blkdev_direct_IO()/blkdev_direct_write()

실행 후:
  raw block device direct I/O code가 bio를 만든다.
```

그림:

```text
io_read()
  -> file->f_op->read_iter()
       |
       v
     blkdev_read_iter()
       |
       v
     blkdev_direct_IO()
```

## 9. raw block async direct I/O에서 bio가 만들어지고 DPAS hook을 탄다

위치:

- `dpas-kernel/block/fops.c:__blkdev_direct_IO_async()`

코드:

```c
bio = bio_alloc_bioset(bdev, nr_pages, opf, GFP_KERNEL,
		       &blkdev_dio_pool);
dio = container_of(bio, struct blkdev_dio, bio);
dio->iocb = iocb;
bio->bi_iter.bi_sector = pos >> SECTOR_SHIFT;
bio->bi_end_io = blkdev_bio_end_io_async;
...
if (iocb->ki_flags & IOCB_HIPRI &&
    blk_dpas_prepare_bio(bdev_get_queue(bio->bi_bdev), bio, iocb)) {
	submit_bio(bio);
	WRITE_ONCE(iocb->private, bio);
} else {
	submit_bio(bio);
}
return -EIOCBQUEUED;
```

변수 변화:

```text
입력:
  iocb->ki_flags has IOCB_HIPRI
  bio = 새로 만든 block I/O
  iocb->private = NULL

실행:
  blk_dpas_prepare_bio(q, bio, iocb)
  submit_bio(bio)
  WRITE_ONCE(iocb->private, bio)

실행 후:
  bio가 block layer에 제출됨
  iocb->private가 poll할 bio를 가리킴
  io_uring에는 -EIOCBQUEUED가 반환됨
```

이 단계의 의미:

- raw block device IOPOLL에서는 `iocb->private`가 곧바로 `bio`를 들고 있다.
- 나중에 `iocb_bio_iopoll()`이 이 pointer를 꺼내 `bio_poll()`을 호출한다.

## 10. XFS 파일은 xfs_file_read_iter()/write_iter()에서 iomap DIO로 간다

위치:

- `dpas-kernel/fs/xfs/xfs_file.c:xfs_file_operations`
- `dpas-kernel/fs/xfs/xfs_file.c:xfs_file_read_iter()`
- `dpas-kernel/fs/xfs/xfs_file.c:xfs_file_dio_read()`
- `dpas-kernel/fs/xfs/xfs_file.c:xfs_file_write_iter()`
- `dpas-kernel/fs/xfs/xfs_file.c:xfs_file_dio_write_aligned()`

코드:

```c
const struct file_operations xfs_file_operations = {
	.llseek		= xfs_file_llseek,
	.read_iter	= xfs_file_read_iter,
	.write_iter	= xfs_file_write_iter,
	...
	.iopoll		= iocb_bio_iopoll,
};
```

```c
if (IS_DAX(inode))
	ret = xfs_file_dax_read(iocb, to);
else if (iocb->ki_flags & IOCB_DIRECT)
	ret = xfs_file_dio_read(iocb, to);
else
	ret = xfs_file_buffered_read(iocb, to);
```

```c
ret = iomap_dio_rw(iocb, to, &xfs_read_iomap_ops, dio_ops, dio_flags,
		NULL, 0);
```

```c
if (iocb->ki_flags & IOCB_DIRECT) {
	ret = xfs_file_dio_write(iocb, from);
	if (ret != -ENOTBLK)
		return ret;
}
```

```c
ret = iomap_dio_rw(iocb, from, ops, dops, dio_flags, ac, 0);
```

변수 변화:

```text
입력:
  file = XFS regular file
  file->f_op = xfs_file_operations
  iocb->ki_flags has IOCB_DIRECT

실행:
  xfs_file_read_iter()/write_iter()
  -> xfs_file_dio_read()/xfs_file_dio_write()
  -> iomap_dio_rw()

실행 후:
  filesystem mapping을 거쳐 bio를 만드는 iomap direct I/O 공통 코드로 들어간다.
```

그림:

```text
io_read()
  -> xfs_file_read_iter()
       |
       +-- buffered read path
       |
       +-- IOCB_DIRECT
             |
             v
           xfs_file_dio_read()
             |
             v
           iomap_dio_rw()
```

## 11. iomap DIO에서도 bio 제출 직전에 DPAS hook을 탄다

위치:

- `dpas-kernel/fs/iomap/direct-io.c:iomap_dio_submit_bio()`
- `dpas-kernel/fs/iomap/direct-io.c:__iomap_dio_rw()`

코드:

```c
static void iomap_dio_submit_bio(const struct iomap_iter *iter,
		struct iomap_dio *dio, struct bio *bio, loff_t pos)
{
	struct kiocb *iocb = dio->iocb;

	atomic_inc(&dio->ref);

	if (iocb->ki_flags & IOCB_HIPRI) {
		if (blk_dpas_prepare_bio(bdev_get_queue(bio->bi_bdev), bio, iocb))
			dio->submit.poll_bio = bio;
	}

	...
	blk_crypto_submit_bio(bio);
}
```

```c
dio->submit.waiter = current;
dio->submit.poll_bio = NULL;
...
WRITE_ONCE(iocb->private, dio->submit.poll_bio);
```

변수 변화:

```text
입력:
  iocb->ki_flags has IOCB_HIPRI
  dio->submit.poll_bio = NULL
  bio = iomap이 만든 direct I/O bio

실행:
  blk_dpas_prepare_bio(q, bio, iocb)
  성공하면 dio->submit.poll_bio = bio
  제출 후 iocb->private = dio->submit.poll_bio

실행 후:
  sync wait loop와 io_uring iopoll path가 같은 bio를 찾을 수 있다.
```

raw block path와 차이:

```text
raw block device:
  __blkdev_direct_IO_async()
    -> iocb->private = bio

filesystem iomap DIO:
  iomap_dio_submit_bio()
    -> dio->submit.poll_bio = bio
  __iomap_dio_rw()
    -> iocb->private = dio->submit.poll_bio
```

## 12. blk_dpas_prepare_bio()가 REQ_POLLED를 유지하거나 제거한다

위치:

- `dpas-kernel/block/blk-core.c:blk_dpas_prepare_bio()`
- `dpas-kernel/include/linux/bio.h:bio_set_polled()`

코드:

```c
static inline void bio_set_polled(struct bio *bio, struct kiocb *kiocb)
{
	bio->bi_opf |= REQ_POLLED;
	if (kiocb->ki_flags & IOCB_NOWAIT)
		bio->bi_opf |= REQ_NOWAIT;
}
```

```c
bool blk_dpas_prepare_bio(struct request_queue *q, struct bio *bio,
			  struct kiocb *iocb)
{
	bool polled = true;
	unsigned long flags;

	if (!q->switch_enabled) {
		bio_set_polled(bio, iocb);
		return true;
	}

	spin_lock_irqsave(&q->dpas_lock, flags);

	switch (q->dpas_mode) {
	case DPAS_MODE_INT:
		iocb->ki_flags &= ~IOCB_HIPRI;
		bio_clear_polled(bio);
		q->dpas_int_cnt++;
		...
		polled = false;
		break;
	case DPAS_MODE_CP:
		bio_set_polled(bio, iocb);
		q->dpas_cp_cnt++;
		break;
	case DPAS_MODE_PAS:
		bio_set_polled(bio, iocb);
		q->dpas_pas_cnt++;
		break;
	case DPAS_MODE_OL:
		bio_set_polled(bio, iocb);
		q->dpas_ol_cnt++;
		break;
	}
```

변수 변화:

```text
입력:
  iocb->ki_flags has IOCB_HIPRI
  bio->bi_opf may not have REQ_POLLED yet
  q->switch_enabled, q->dpas_mode decide policy

CP/PAS/OL 또는 switch disabled:
  bio->bi_opf |= REQ_POLLED
  return true

INT:
  iocb->ki_flags &= ~IOCB_HIPRI
  bio->bi_opf &= ~REQ_POLLED
  return false
```

이 단계의 의미:

- `io_uring`은 "이 요청은 IOPOLL"이라고 `IOCB_HIPRI`를 붙인다.
- DPAS는 실제 block submission 직전 이 요청을 계속 polling으로 보낼지, interrupt I/O로 돌릴지 결정한다.

## 13. submit_bio()가 bio를 blk-mq request로 바꾼다

위치:

- `dpas-kernel/block/blk-core.c:submit_bio()`
- `dpas-kernel/block/blk-core.c:__submit_bio()`
- `dpas-kernel/block/blk-mq.c:blk_mq_submit_bio()`

코드:

```c
void submit_bio(struct bio *bio)
{
	if (bio_op(bio) == REQ_OP_READ) {
		task_io_account_read(bio->bi_iter.bi_size);
		count_vm_events(PGPGIN, bio_sectors(bio));
	} else if (bio_op(bio) == REQ_OP_WRITE) {
		count_vm_events(PGPGOUT, bio_sectors(bio));
	}

	bio_set_ioprio(bio);
	submit_bio_noacct(bio);
}
```

```c
static void __submit_bio(struct bio *bio)
{
	blk_start_plug(&plug);

	if (!bdev_test_flag(bio->bi_bdev, BD_HAS_SUBMIT_BIO)) {
		blk_mq_submit_bio(bio);
	} else if (likely(bio_queue_enter(bio) == 0)) {
		...
	}
```

```c
void blk_mq_submit_bio(struct bio *bio)
{
	struct request_queue *q = bdev_get_queue(bio->bi_bdev);
	...
	struct request *rq;
	...
	blk_mq_bio_to_request(rq, bio, nr_segs);
	...
	hctx = rq->mq_hctx;
	...
	blk_mq_run_dispatch_ops(q, blk_mq_try_issue_directly(hctx, rq));
}
```

변수 변화:

```text
입력:
  bio->bi_bdev = 대상 block device
  bio->bi_opf may have REQ_POLLED

실행:
  submit_bio()
  -> submit_bio_noacct()
  -> __submit_bio()
  -> blk_mq_submit_bio()
  -> blk_mq_bio_to_request()

실행 후:
  request rq가 만들어지고 rq->bio가 원래 bio chain을 가리킨다.
  rq->mq_hctx가 선택된다.
```

직관:

```text
bio:
  "어느 sector에 몇 bytes를 읽거나 쓸 것인가"

request:
  "blk-mq가 hardware queue에 보낼 제출 단위"

hctx:
  "실제 poll/dispatch 대상 hardware context"
```

## 14. blk_mq_start_request()가 bio cookie에 hctx 번호를 써준다

위치:

- `dpas-kernel/block/blk-mq.c:blk_mq_start_request()`

코드:

```c
void blk_mq_start_request(struct request *rq)
{
	struct request_queue *q = rq->q;
	...
	WRITE_ONCE(rq->state, MQ_RQ_IN_FLIGHT);
	rq->mq_hctx->tags->rqs[rq->tag] = rq;
	...
	if (rq->bio && rq->bio->bi_opf & REQ_POLLED)
	        WRITE_ONCE(rq->bio->bi_cookie, rq->mq_hctx->queue_num);
}
```

변수 변화:

```text
입력:
  rq->bio = bio
  bio->bi_opf has REQ_POLLED
  rq->mq_hctx->queue_num = 예: 3
  bio->bi_cookie = BLK_QC_T_NONE 또는 이전 값

실행 후:
  bio->bi_cookie = 3
```

이 단계가 중요한 이유:

- 나중에 `bio_poll()`은 `request *rq`를 받지 않고 `bio *bio`만 받는다.
- 따라서 어느 hctx를 poll해야 하는지 `bio->bi_cookie`에 저장해 둔다.

그림:

```text
request rq
  rq->bio -----> bio
  rq->mq_hctx -> hctx(queue_num=3)
                  |
                  v
           bio->bi_cookie = 3
```

## 15. io_uring GETEVENTS 쪽에서 iopoll completion을 회수한다

위치:

- `dpas-kernel/io_uring/io_uring.c:SYSCALL_DEFINE6(io_uring_enter)`
- `dpas-kernel/io_uring/io_uring.c:io_iopoll_check()`
- `dpas-kernel/io_uring/rw.c:io_do_iopoll()`

코드:

```c
if (flags & IORING_ENTER_GETEVENTS) {
	if (ctx->int_flags & IO_RING_F_SYSCALL_IOPOLL) {
		mutex_lock(&ctx->uring_lock);
		ret2 = io_validate_ext_arg(ctx, flags, argp, argsz);
		if (likely(!ret2))
			ret2 = io_iopoll_check(ctx, min_complete);
		mutex_unlock(&ctx->uring_lock);
	} else {
		...
		ret2 = io_cqring_wait(ctx, min_complete, flags, &ext_arg);
	}
}
```

```c
do {
	...
	ret = io_do_iopoll(ctx, !min_events);
	if (unlikely(ret < 0))
		return ret;
	...
} while (io_cqring_events(ctx) < min_events);
```

```c
list_for_each_entry(req, &ctx->iopoll_list, iopoll_node) {
	if (READ_ONCE(req->iopoll_completed))
		break;

	if (ctx->flags & IORING_SETUP_HYBRID_IOPOLL)
		ret = io_uring_hybrid_poll(req, &iob, poll_flags);
	else
		ret = io_uring_classic_poll(req, &iob, poll_flags);
	...
}
```

변수 변화:

```text
입력:
  ctx->iopoll_list에 발행된 REQ_F_IOPOLL 요청들이 있음
  userspace가 GETEVENTS로 completion을 기다림

실행:
  io_iopoll_check()
  -> io_do_iopoll()
  -> io_uring_classic_poll()/hybrid_poll()

실행 후:
  완료된 req는 iopoll_completed를 보고 completion list로 이동한다.
  CQE가 userspace에 보일 준비를 한다.
```

## 16. io_uring_classic_poll()은 file->f_op->iopoll()을 호출한다

위치:

- `dpas-kernel/io_uring/rw.c:io_uring_classic_poll()`
- `dpas-kernel/block/blk-core.c:iocb_bio_iopoll()`

코드:

```c
static int io_uring_classic_poll(struct io_kiocb *req, struct io_comp_batch *iob,
				unsigned int poll_flags)
{
	struct file *file = req->file;

	if (io_is_uring_cmd(req)) {
		struct io_uring_cmd *ioucmd;

		ioucmd = io_kiocb_to_cmd(req, struct io_uring_cmd);
		return file->f_op->uring_cmd_iopoll(ioucmd, iob, poll_flags);
	} else {
		struct io_rw *rw = io_kiocb_to_cmd(req, struct io_rw);

		return file->f_op->iopoll(&rw->kiocb, iob, poll_flags);
	}
}
```

```c
int iocb_bio_iopoll(struct kiocb *kiocb, struct io_comp_batch *iob,
		unsigned int flags)
{
	struct bio *bio;
	int ret = 0;
	...
	rcu_read_lock();
	bio = READ_ONCE(kiocb->private);
	if (bio)
		ret = bio_poll(bio, iob, flags);
	rcu_read_unlock();

	return ret;
}
```

변수 변화:

```text
입력:
  req = io_uring read/write request
  rw->kiocb.private = poll 대상 bio
  file->f_op->iopoll = iocb_bio_iopoll

실행:
  file->f_op->iopoll(&rw->kiocb, ...)
  -> iocb_bio_iopoll()
  -> bio = READ_ONCE(kiocb->private)
  -> bio_poll(bio, ...)

실행 후:
  io_uring completion polling이 block layer bio polling으로 연결된다.
```

이 단계의 의미:

- io_uring은 `bio`를 직접 모르고 `kiocb`를 들고 있다.
- block/filesystem DIO submit side가 `kiocb->private`에 bio를 저장해 두었기 때문에, completion poll side가 같은 bio를 다시 찾을 수 있다.

## 17. bio_poll()은 bio cookie로 hctx를 복원한다

위치:

- `dpas-kernel/block/blk-core.c:bio_poll()`
- `dpas-kernel/block/blk-mq.c:blk_mq_poll_bio()`

코드:

```c
int bio_poll(struct bio *bio, struct io_comp_batch *iob, unsigned int flags)
{
	blk_qc_t cookie = READ_ONCE(bio->bi_cookie);
	struct block_device *bdev;
	struct request_queue *q;
	int ret = 0;

	bdev = READ_ONCE(bio->bi_bdev);
	if (!bdev)
		return 0;

	q = bdev_get_queue(bdev);
	if (cookie == BLK_QC_T_NONE)
		return 0;

	blk_flush_plug(current->plug, false);
	...
	if (queue_is_mq(q)) {
		ret = blk_mq_poll_bio(q, bio, cookie, iob, flags);
	}
	blk_queue_exit(q);
	return ret;
}
```

```c
int blk_mq_poll_bio(struct request_queue *q, struct bio *bio, blk_qc_t cookie,
		struct io_comp_batch *iob, unsigned int flags)
{
	struct blk_mq_pas_poll_ctx pas = {};
	struct blk_mq_hw_ctx *hctx;
	unsigned int poll_count = 0;
	int ret;

	if (!blk_mq_can_poll(q))
		return 0;

	hctx = q->queue_hw_ctx[cookie];

	if (q->pas_enabled)
		blk_mq_poll_pas_sleep(q, bio, flags, &pas);
	else
		blk_mq_poll_lhp_sleep(q, bio, flags);

	ret = __blk_hctx_poll(q, hctx, iob, flags, &poll_count);
	blk_mq_poll_pas_complete(q, &pas, ret, poll_count);

	return ret;
}
```

변수 변화:

```text
입력:
  bio->bi_bdev = 대상 block device
  bio->bi_cookie = hctx queue_num
  bio->bi_opf has REQ_POLLED

실행:
  q = bdev_get_queue(bio->bi_bdev)
  hctx = q->queue_hw_ctx[bio->bi_cookie]
  PAS/LHP sleep policy 적용 가능
  __blk_hctx_poll(q, hctx, ...)

실행 후:
  driver poll 함수가 completion을 확인한다.
```

## 18. __blk_hctx_poll()은 실제 driver poll callback을 부른다

위치:

- `dpas-kernel/block/blk-mq.c:__blk_hctx_poll()`
- `dpas-kernel/drivers/nvme/host/pci.c:nvme_poll()`

코드:

```c
static int __blk_hctx_poll(struct request_queue *q, struct blk_mq_hw_ctx *hctx,
			   struct io_comp_batch *iob, unsigned int flags,
			   unsigned int *poll_countp)
{
	unsigned int poll_count = 0;
	long state = get_current_state();
	bool stateful_wait = state != TASK_RUNNING;
	int ret;

	do {
		ret = q->mq_ops->poll(hctx, iob);
		if (ret > 0) {
			if (poll_countp)
				*poll_countp = poll_count;
			if (stateful_wait)
				__set_current_state(TASK_RUNNING);
			return ret;
		}
		...
		cpu_relax();
		poll_count++;
	} while (!need_resched());
	...
	return 0;
}
```

```c
static const struct blk_mq_ops nvme_mq_ops = {
	.queue_rq	= nvme_queue_rq,
	...
	.poll		= nvme_poll,
};
```

```c
static int nvme_poll(struct blk_mq_hw_ctx *hctx, struct io_comp_batch *iob)
{
	struct nvme_queue *nvmeq = hctx->driver_data;
	bool found;

	if (!test_bit(NVMEQ_POLLED, &nvmeq->flags) ||
	    !nvme_cqe_pending(nvmeq))
		return 0;

	spin_lock(&nvmeq->cq_poll_lock);
	found = nvme_poll_cq(nvmeq, iob);
	spin_unlock(&nvmeq->cq_poll_lock);

	return found;
}
```

변수 변화:

```text
입력:
  hctx = poll할 hardware context
  q->mq_ops->poll = device driver poll callback

NVMe PCI:
  q->mq_ops->poll == nvme_poll
  hctx->driver_data == struct nvme_queue

실행 후:
  nvme completion queue에 완료가 있으면 completion batch로 처리된다.
```

중요한 의미:

- DPAS/PAS/LHP는 driver 바깥 block layer 정책이다.
- 실제 NVMe completion queue 확인은 여전히 `nvme_poll()`이 한다.

## 19. 한 요청을 예시 값으로 따라가기

가정:

```text
요청:
  IORING_OP_READ
  IORING_SETUP_IOPOLL ring
  O_DIRECT file
  XFS 위의 4KB read
  NVMe poll queue 사용

예시 값:
  sqe->opcode = IORING_OP_READ
  sqe->user_data = 0xabc
  iov_iter_count(&io->iter) = 4096
  bio_sectors(bio) = 8
  rq->mq_hctx->queue_num = 3
  q->dpas_mode = DPAS_MODE_PAS
```

실행:

```text
1. io_uring_enter(fd, to_submit=1, ...)
   -> ctx = file->private_data

2. io_submit_sqes(ctx, 1)
   -> io_alloc_req()
   -> io_get_sqe()
   -> io_submit_sqe(ctx, req, sqe, ...)

3. io_init_req()
   req->opcode = IORING_OP_READ
   req->cqe.user_data = 0xabc

4. opdef table
   IORING_OP_READ
     prep  = io_prep_read
     issue = io_read

5. io_issue_sqe()
   -> io_assign_file()
   -> io_read(req, issue_flags)

6. io_rw_init_file()
   ctx has IORING_SETUP_IOPOLL
   file supports iopoll
   kiocb has IOCB_DIRECT

   req->flags |= REQ_F_IOPOLL
   kiocb->ki_flags |= IOCB_HIPRI
   req->iopoll_completed = 0

7. io_read()
   -> io_iter_do_read()
   -> file->f_op->read_iter()
   -> xfs_file_read_iter()
   -> xfs_file_dio_read()
   -> iomap_dio_rw()

8. iomap_dio_submit_bio()
   bio = 4KB read bio
   blk_dpas_prepare_bio(q, bio, iocb)

   q->dpas_mode = DPAS_MODE_PAS
     -> bio_set_polled(bio, iocb)
     -> bio->bi_opf |= REQ_POLLED
     -> q->dpas_pas_cnt++

   dio->submit.poll_bio = bio
   blk_crypto_submit_bio(bio)

9. __iomap_dio_rw()
   WRITE_ONCE(iocb->private, dio->submit.poll_bio)

10. submit_bio()
    -> blk_mq_submit_bio()
    -> request 생성
    -> rq->bio = bio
    -> rq->mq_hctx = hctx3

11. blk_mq_start_request()
    bio->bi_cookie = rq->mq_hctx->queue_num = 3

12. io_uring completion poll
    io_iopoll_req_issued()
      -> req를 ctx->iopoll_list에 추가

    io_uring_enter(..., IORING_ENTER_GETEVENTS, ...)
      -> io_iopoll_check()
      -> io_do_iopoll()
      -> io_uring_classic_poll()
      -> file->f_op->iopoll(&rw->kiocb, ...)
      -> iocb_bio_iopoll()
      -> bio = iocb->private
      -> bio_poll(bio, ...)

13. bio_poll()
    cookie = bio->bi_cookie = 3
    q = bdev_get_queue(bio->bi_bdev)
    blk_mq_poll_bio(q, bio, 3, ...)

14. blk_mq_poll_bio()
    hctx = q->queue_hw_ctx[3]
    q->pas_enabled이면 PAS sleep policy 적용
    __blk_hctx_poll(q, hctx, ...)

15. __blk_hctx_poll()
    q->mq_ops->poll(hctx, iob)

    NVMe PCI이면:
      q->mq_ops->poll = nvme_poll
      nvme_poll()이 completion queue 확인

16. completion 발견
    io_complete_rw_iopoll()
      -> req->iopoll_completed = 1

    io_do_iopoll()
      -> req를 completion list로 이동
      -> CQE flush
```

한 줄 결론:

```text
io_uring read/write는 SQE를 io_kiocb로 바꾼 뒤 file->f_op->read_iter/write_iter로 내려가고,
IOPOLL이면 kiocb의 IOCB_HIPRI가 bio의 REQ_POLLED로 이어지며,
completion 쪽은 iocb->private의 bio를 bio_poll()로 다시 찾아 hctx 기반 driver poll까지 간다.
```

## 20. 왜 이 구조가 필요한가

필요한 정보는 계층마다 다르게 흩어져 있다.

```text
io_uring layer:
  SQE opcode, user_data, ring flags, REQ_F_IOPOLL, completion queue

VFS/file layer:
  target file, file->f_op, kiocb, iov_iter

filesystem/block direct I/O layer:
  bio 생성, bio end_io, iocb->private에 poll 대상 bio 저장

DPAS/block layer:
  request_queue mode, REQ_POLLED 유지/제거, PAS/LHP sleep policy

blk-mq layer:
  bio -> request 변환, hctx 선택, bio->bi_cookie에 hctx 번호 저장

driver layer:
  q->mq_ops->poll(), NVMe면 nvme_poll()
```

그래서 전체 구조는 이렇게 읽는 것이 좋다.

```text
SQE는 "무슨 작업을 해줘"라는 userspace 요청서
io_kiocb는 io_uring이 들고 다니는 커널 요청 객체
kiocb는 VFS/file operation에 넘기는 I/O control block
bio는 block device에 내려가는 실제 sector I/O 묶음
request는 blk-mq가 hardware queue에 제출하는 단위
hctx는 poll/dispatch할 hardware context
```

## 21. 현재 이해할 때 주의할 점

- `io_uring`의 일반 read/write 경로와 `IORING_OP_URING_CMD` 경로는 다르다.
  - read/write: `io_read/io_write -> file->f_op->read_iter/write_iter`
  - uring_cmd: `io_uring_cmd -> file->f_op->uring_cmd`
- `IORING_SETUP_IOPOLL`이 바로 `REQ_POLLED`를 붙이는 것은 아니다. 먼저 `io_rw_init_file()`에서 `IOCB_HIPRI`가 되고, direct I/O submit 쪽의 `blk_dpas_prepare_bio()`가 `bio_set_polled()`를 호출해야 `REQ_POLLED`가 붙는다.
- raw block device와 XFS 파일은 중간 direct I/O 구현이 다르다.
  - raw block device: `block/fops.c::__blkdev_direct_IO_async()`
  - XFS file: `xfs_file_dio_read/write() -> iomap_dio_rw() -> iomap_dio_submit_bio()`
- `iocb->private`는 polling completion 쪽에서 매우 중요하다. `iocb_bio_iopoll()`은 여기 저장된 `bio`를 읽어서 `bio_poll()`을 호출한다.
- `bio->bi_cookie`는 이 포팅에서 hctx selector로 중요하다. `blk_mq_start_request()`가 polled bio에 `rq->mq_hctx->queue_num`을 써주지 않으면 `bio_poll()`이 어느 hctx를 poll할지 알 수 없다.
- DPAS INT 모드는 사용자가 IOPOLL/HIPRI로 요청했더라도 `blk_dpas_prepare_bio()`에서 `IOCB_HIPRI`와 `REQ_POLLED`를 제거할 수 있다.
- 실제 device completion 확인은 DPAS 코드가 아니라 driver callback인 `q->mq_ops->poll()`이 한다. NVMe PCI 기준으로는 `nvme_poll()`이다.
- 이 보고서는 코드 경로 정리다. runtime에서 특정 workload가 이 경로를 탔다는 검증은 kprobe/ftrace/perf 같은 별도 실행 증거가 있어야 한다.
