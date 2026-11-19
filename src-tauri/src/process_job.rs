//! Windows closes this job with the app, taking even orphaned descendants with it.

/// The app-wide job, created on first use; null if Windows refused it.
#[cfg(windows)]
fn job() -> windows_sys::Win32::Foundation::HANDLE {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::*;
    static JOB: OnceLock<isize> = OnceLock::new();
    *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            CloseHandle(job);
            return 0;
        }
        job as isize
    }) as windows_sys::Win32::Foundation::HANDLE
}

pub(crate) fn assign(pid: u32) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        let job = job();
        if !job.is_null() {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                if AssignProcessToJobObject(job, process) == 0 {
                    eprintln!("process job: could not protect child {pid}");
                }
                CloseHandle(process);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
}

/// A job of its own for one child and everything it starts, nested in the
/// app-wide one (call `assign` first). Dropping it kills whatever is still in
/// it - the descendants a child leaves behind when it exits on its own (an
/// agent adapter that crashed or hit a limit: its real CLI, MCP servers, dev
/// servers the agent ran), which `taskkill /T` can no longer reach through
/// the dead parent. A no-op outside Windows (process groups do that there).
pub(crate) struct TreeJob(#[cfg(windows)] isize);

impl TreeJob {
    pub(crate) fn new(pid: u32) -> Option<Self> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::*;
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            let ok = !process.is_null()
                && SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                ) != 0
                && AssignProcessToJobObject(job, process) != 0;
            if !process.is_null() {
                CloseHandle(process);
            }
            if !ok {
                eprintln!("process job: no own job for child {pid}");
                CloseHandle(job);
                return None;
            }
            Some(Self(job as isize))
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            None
        }
    }
}

#[cfg(windows)]
impl Drop for TreeJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _) };
    }
}

/// Every process currently in the job: the children Flowcode started
/// (terminals, agents, sign-in helpers) and all their descendants, orphans
/// included. Empty if the job does not exist yet.
#[cfg(windows)]
pub(crate) fn pids() -> Vec<u32> {
    pids_of(job())
}

#[cfg(windows)]
fn pids_of(job: windows_sys::Win32::Foundation::HANDLE) -> Vec<u32> {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    };
    if job.is_null() {
        return Vec::new();
    }
    // Header (two u32) + one usize per pid; grow until the list fits.
    let mut slots = 256usize;
    loop {
        let mut buf = vec![0usize; 1 + slots];
        let ok = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                buf.as_mut_ptr() as *mut _,
                (buf.len() * std::mem::size_of::<usize>()) as u32,
                std::ptr::null_mut(),
            )
        };
        let list = unsafe { &*(buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
        let (assigned, listed) =
            (list.NumberOfAssignedProcesses as usize, list.NumberOfProcessIdsInList as usize);
        if ok == 0 && assigned <= slots {
            return Vec::new();
        }
        if assigned > listed && slots < 65_536 {
            slots = assigned + 64;
            continue;
        }
        return buf[1..1 + listed.min(slots)].iter().map(|&p| p as u32).collect();
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn assigned_child_is_listed() {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "ping -n 3 127.0.0.1 >NUL"])
            .spawn()
            .unwrap();
        super::assign(child.id());
        let listed = super::pids().contains(&child.id());
        let _ = child.kill();
        assert!(listed);
    }

    #[test]
    fn dropping_a_tree_job_kills_what_an_exited_child_left() {
        // cmd waits a second (so the job is in place), starts a long ping in
        // the background and exits, orphaning it.
        let mut parent = std::process::Command::new("cmd")
            .args(["/C", r"C:\Windows\System32\PING.EXE -n 2 127.0.0.1 >NUL & start /B C:\Windows\System32\PING.EXE -n 60 127.0.0.1 >NUL"])
            .spawn()
            .unwrap();
        super::assign(parent.id());
        let job = super::TreeJob::new(parent.id()).expect("tree job");
        parent.wait().unwrap();
        let orphans = super::pids_of(job.0 as _);
        assert!(!orphans.is_empty(), "the background ping should be in the tree job");
        assert!(orphans.iter().all(|p| super::pids().contains(p)), "nested in the app-wide job");
        drop(job);
        std::thread::sleep(std::time::Duration::from_millis(500));
        let left: Vec<u32> = super::pids().into_iter().filter(|p| orphans.contains(p)).collect();
        assert!(left.is_empty(), "still alive: {left:?}");
    }
}
