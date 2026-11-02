"""Render actual Slurm configs with representative Ampere facts, without a VM."""
from pathlib import Path
import re
import unittest
from jinja2 import Environment, FileSystemLoader, StrictUndefined

ROOT = Path(__file__).resolve().parents[1] / 'ansible/roles/slurm_podman_lab/templates'


class LabTemplateTests(unittest.TestCase):
    def test_separate_executor_uses_real_topology_and_reserves_host_memory(self):
        env = Environment(loader=FileSystemLoader(ROOT), undefined=StrictUndefined)
        env.filters['regex_replace'] = lambda value, pattern, replacement: re.sub(pattern, replacement, value)
        for memory in (4096, 8192, 24576):
            with self.subTest(memory=memory):
                text = env.get_template('slurm.conf.j2').render(
                    slurm_lab_cluster='openbatch', slurm_lab_partition='debug',
                    groups={'lab_controller': ['portal'], 'lab_workers': ['worker1']},
                    hostvars={
                        'portal': dict(ansible_hostname='openbatch', ansible_host='10.0.0.10'),
                        'worker1': dict(ansible_hostname='ampere-worker', ansible_host='10.0.0.20', ansible_memtotal_mb=memory,
                                        slurm_lab_hardware={'stdout_lines': [f'NodeName=ampere-worker CPUs=4 Boards=1 SocketsPerBoard=1 CoresPerSocket=4 ThreadsPerCore=1 RealMemory={memory}']}),
                    },
                )
                nodes = [line for line in text.splitlines() if line.startswith('NodeName=')]
                self.assertEqual(len(nodes), 1)
                self.assertIn('NodeName=worker1 NodeAddr=10.0.0.20 NodeHostname=ampere-worker', nodes[0])
                self.assertIn('CPUs=4 Boards=1 SocketsPerBoard=1 CoresPerSocket=4 ThreadsPerCore=1', nodes[0])
                configured_memory = int(re.search(r'RealMemory=(\d+)', nodes[0])[1])
                self.assertGreater(configured_memory, 0)
                self.assertLessEqual(configured_memory, memory - 1024)
                self.assertIn('TaskPlugin=task/cgroup,task/affinity', text)
                self.assertIn('SlurmctldHost=openbatch(10.0.0.10)', text)

    def test_specific_password_exception_precedes_general_denial(self):
        env = Environment(loader=FileSystemLoader(ROOT), undefined=StrictUndefined)
        text = env.get_template('sshd.conf.j2').render(slurm_lab_user='pesquisador', ansible_host='10.0.0.10')
        self.assertLess(text.index('PasswordAuthentication yes'), text.index('PasswordAuthentication no'))
        self.assertIn('Match User pesquisador Address 10.0.0.10,127.0.0.1', text)
        self.assertTrue(text.rstrip().endswith('Match all'))


if __name__ == '__main__':
    unittest.main()
