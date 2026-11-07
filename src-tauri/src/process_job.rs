//! Windows closes this job with the app, taking even orphaned descendants with it.

pub(crate) fn assign(pid: u32) {
    #[cfg(windows)]
    unsafe {
        use std::sync::OnceLock;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::*;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        static JOB: OnceLock<isize> = OnceLock::new();
        let job = *JOB.get_or_init(|| {
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
        }) as windows_sys::Win32::Foundation::HANDLE;
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
